import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { createId } from "@paralleldrive/cuid2";
import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    asyncLock,
    detach,
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { NodeModule } from "../node/index.js";
import { TailcatModule, type TailcatNamedExposure } from "../tailcat/index.js";
import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { MobilePairing, type MobilePairingPhoneStatus } from "./impl/MobilePairing.js";
import {
    DEVICE_TOKEN_PATTERN,
    handshakeIdSchema,
    pairingConfirmRequestSchema,
    pairingRejectRequestSchema,
    pairingRevealRequestSchema,
    pairingStartRequestSchema,
} from "./impl/mobilePairingRequests.js";
import {
    readMobileJsonBody,
    sendMobileJson,
    startMobileListener,
    type MobileListener,
} from "./impl/startMobileListener.js";
import {
    mobileConnectorSnapshotSchema,
    STANDALONE_MOBILE_OWNER,
    type MobileConnectorListener,
    type MobileConnectorSnapshot,
    type MobileConnectorStatus,
    type MobileDeviceRequestHandler,
    type MobileOwner,
} from "./MobileConnector.js";
import { MobileConnectorError } from "./MobileConnectorError.js";
import { mobileConnectorMigrations } from "./MobileConnectorMigrations.js";
import { deleteMobileDevice } from "./persistence/deleteMobileDevice.js";
import { insertMobileDevice } from "./persistence/insertMobileDevice.js";
import { queryMobileDeviceByTokenHash } from "./persistence/queryMobileDeviceByTokenHash.js";
import { queryMobileDeviceOwners } from "./persistence/queryMobileDeviceOwners.js";
import { queryMobileDevices } from "./persistence/queryMobileDevices.js";
import { touchMobileDevice } from "./persistence/touchMobileDevice.js";

const RECONCILE_FUNCTION = "mobile-connector-reconcile";
const RECONCILE_OPERATION = "mobile-connector-reconcile";
const RECONCILE_LOCK = "mobile-connector-socket";
const TAILCAT_EXPOSURE = "mobile";
const LAST_SEEN_INTERVAL_MS = 60_000;
const MAX_WAIT_SECONDS = 25;
const PAIRING_PREFIX = "/mobile/v1/pairing/";
/**
 * How long the socket stays open after a pairing ends, so the answer to the request that ended it
 * and the phone's woken status read can still be delivered before an unused socket closes.
 */
const LINGER_MS = 3_000;

/**
 * Phones pair with this daemon and then reach it directly over a dedicated Tailcat socket.
 *
 * The socket has its own Tailcat identity and forwards to this module's own loopback listener,
 * never to the main API. It is open only while a pairing is active or a device is paired, and a
 * restart reopens it when devices exist. Pairing is memory-only and single-use: a QR code holds a
 * five-minute token, the phone commits to its key before seeing the daemon's, and a device is
 * persisted, by the SHA-256 of its derived token, only after both people confirm the emoji. The
 * listener accepts the unauthenticated pairing routes and device tokens, nothing else.
 */
export class MobileConnectorModule implements AgentModule {
    readonly name = "mobileConnector";
    readonly migrations = mobileConnectorMigrations;

    readonly #config: ConfigModule;
    readonly #team: TeamModule;
    readonly #node: NodeModule;
    readonly #tailcat: TailcatModule;
    readonly #durable: DurableFunctionsModule;
    readonly #socketLock: AsyncLock = asyncLock({ reentry: "block" });
    readonly #pairingLock: AsyncLock = asyncLock({ reentry: "block" });
    readonly #uuid = createUuidV7Factory();
    readonly #listeners = new Set<MobileConnectorListener>();
    /** Each owner's current or most recently finished pairing. */
    readonly #pairings = new Map<MobileOwner, MobilePairing>();
    readonly #byToken = new Map<string, MobilePairing>();
    readonly #byHandshake = new Map<string, MobilePairing>();
    readonly #expiries = new Map<MobilePairing, NodeJS.Timeout>();
    readonly #versions = new Map<MobileOwner, { version: string; updatedAt: number }>();
    readonly #deviceSockets = new Map<string, Set<Socket>>();
    readonly #lastTouched = new Map<string, number>();
    #ctx: Context | undefined;
    #closed = false;
    #status: MobileConnectorStatus;
    #error: string | null = null;
    #listener: MobileListener | undefined;
    #exposure: TailcatNamedExposure | undefined;
    #deviceHandler: MobileDeviceRequestHandler | undefined;
    #linger: NodeJS.Timeout | undefined;

    constructor(
        config: ConfigModule,
        team: TeamModule,
        node: NodeModule,
        tailcat: TailcatModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#team = team;
        this.#node = node;
        this.#tailcat = tailcat;
        this.#durable = durableFunctions;
        this.#status = config.mobileConnectorEnabled ? "closed" : "disabled";
        durableFunctions.register({
            name: RECONCILE_FUNCTION,
            argumentsSchema: Type.Object({}, { additionalProperties: false }),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                await this.#reconcile(ctx);
                return null;
            },
        });
    }

    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        const root = withAgentDatabase(detach(ctx).named("mobile-connector"), ctx.db);
        this.#ctx = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        return {
            afterStart: async () => {
                // Reopening for existing devices must not hold up startup: Tailcat can take a
                // while, and a failure is reported in the snapshot rather than failing the daemon.
                const moduleCtx = this.#moduleContext();
                void this.#reconcile(moduleCtx).catch((error: unknown) => {
                    moduleCtx.log.warn("The mobile connector could not reopen.", {}, error);
                });
            },
        };
    };

    /** The caller's view: the socket, their pairing, and their paired devices. */
    async snapshot(ctx: Context): Promise<MobileConnectorSnapshot> {
        return await this.#snapshotFor(ctx, this.#owner(ctx));
    }

    /**
     * Start a pairing, replacing the caller's previous one, and open the socket for it. The
     * returned snapshot carries the QR code, or a failed pairing when the socket could not open.
     */
    async startPairing(ctx: Context): Promise<MobileConnectorSnapshot> {
        const owner = this.#owner(ctx);
        if (!this.#config.mobileConnectorEnabled) {
            throw new MobileConnectorError(
                "unsupported",
                "Direct phone connections are turned off on this computer.",
            );
        }
        const name = (await this.#node.get(ctx)).name;
        const pairing = await this.#pairingLock.runInLock(ctx, async () => {
            this.#assertOpen();
            this.#dismiss(this.#pairings.get(owner), "cancelled");
            const created = new MobilePairing(createId(), owner, Date.now());
            this.#pairings.set(owner, created);
            this.#byToken.set(created.tokenHash, created);
            const timer = setTimeout(
                () => void this.#expire(created),
                Math.max(0, created.expiresAt - Date.now()),
            );
            timer.unref();
            this.#expiries.set(created, timer);
            return created;
        });
        this.#announce(ctx, [owner]);
        await this.#reconcile(ctx).catch(() => undefined);
        await this.#pairingLock.runInLock(ctx, async () => {
            const exposure = this.#exposure;
            const token = pairing.token;
            if (!pairing.waitingForQr || token === undefined) return;
            if (exposure === undefined) {
                pairing.end("failed", this.#error ?? "The phone connection socket did not open.");
                this.#release(pairing);
                return;
            }
            pairing.showQr(
                encodeQr({
                    v: 1,
                    a: exposure.address,
                    p: exposure.port,
                    t: token,
                    n: name,
                    e: pairing.expiresAt,
                }),
            );
        });
        this.#announce(ctx, [owner]);
        return await this.#snapshotFor(ctx, owner);
    }

    /** The desktop person says the emoji match. The device is persisted once the phone agrees. */
    async confirmPairing(ctx: Context, pairingId: string): Promise<MobileConnectorSnapshot> {
        const owner = this.#owner(ctx);
        await this.#pairingLock.runInLock(ctx, async () => {
            const pairing = this.#pairings.get(owner);
            if (pairing === undefined || pairing.id !== pairingId) {
                throw new MobileConnectorError("not_found", "That pairing is no longer current.");
            }
            if (this.#expireIfDue(pairing) || pairing.snapshot().status !== "verifying") {
                throw new MobileConnectorError(
                    "conflict",
                    "That pairing is not waiting for emoji confirmation.",
                );
            }
            pairing.confirmDesktop();
            await this.#completeIfReady(ctx, pairing);
        });
        this.#announce(ctx, [owner]);
        return await this.#snapshotFor(ctx, owner);
    }

    /**
     * Cancel the caller's active pairing, or dismiss a finished one so it leaves the snapshot.
     * Cancelling anything else changes nothing, so a repeated cancel is harmless.
     */
    async cancelPairing(ctx: Context, pairingId: string): Promise<MobileConnectorSnapshot> {
        const owner = this.#owner(ctx);
        let changed = false;
        await this.#pairingLock.runInLock(ctx, async () => {
            const pairing = this.#pairings.get(owner);
            if (pairing === undefined || pairing.id !== pairingId) return;
            changed = true;
            if (pairing.active) {
                pairing.end("cancelled");
                this.#release(pairing);
                return;
            }
            this.#forget(pairing);
        });
        if (changed) this.#announce(ctx, [owner]);
        return await this.#snapshotFor(ctx, owner);
    }

    /** Forget one of the caller's phones and close every request it has open. */
    async revokeDevice(ctx: Context, deviceId: string): Promise<MobileConnectorSnapshot> {
        const owner = this.#owner(ctx);
        await ctx.inTx(async (txCtx) => {
            if (!(await deleteMobileDevice(txCtx, owner, deviceId))) {
                throw new MobileConnectorError("not_found", "That phone is not paired.");
            }
            await this.#scheduleReconcile(txCtx);
            afterCommit(txCtx, async () => {
                for (const socket of this.#deviceSockets.get(deviceId) ?? []) socket.destroy();
                this.#deviceSockets.delete(deviceId);
                this.#lastTouched.delete(deviceId);
            });
            this.#announce(txCtx, [owner]);
        });
        return await this.#snapshotFor(ctx, owner);
    }

    /** Watch snapshots as they change; each event belongs to one owner only. */
    onEvent(listener: MobileConnectorListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Serve requests that carried a valid device token, with the device's owner as authority.
     * Until something is registered, such requests are answered as unavailable.
     */
    serveDeviceRequests(handler: MobileDeviceRequestHandler): () => void {
        if (this.#deviceHandler !== undefined) {
            throw new Error("Mobile device requests already have a handler.");
        }
        this.#deviceHandler = handler;
        return () => {
            if (this.#deviceHandler === handler) this.#deviceHandler = undefined;
        };
    }

    /** Stop live work. Paired devices stay, and the next start reopens the socket for them. */
    async close(ctx: Context): Promise<void> {
        this.#closed = true;
        if (this.#linger !== undefined) clearTimeout(this.#linger);
        this.#linger = undefined;
        await this.#pairingLock.runInLock(ctx, async () => {
            for (const timer of this.#expiries.values()) clearTimeout(timer);
            this.#expiries.clear();
            for (const pairing of this.#pairings.values()) pairing.end("cancelled");
            this.#pairings.clear();
            this.#byToken.clear();
            this.#byHandshake.clear();
        });
        await this.#socketLock.runInLock(ctx, async () => {
            await this.#closeSocket();
        });
    }

    // Socket lifetime.

    async #scheduleReconcile(ctx: Context): Promise<void> {
        await this.#durable.invoke(ctx, {
            function: RECONCILE_FUNCTION,
            arguments: {},
            operationId: RECONCILE_OPERATION,
            lockKeys: [RECONCILE_LOCK],
        });
    }

    /** Open the socket while a pairing is active or a device exists, and close it otherwise. */
    async #reconcile(ctx: Context): Promise<void> {
        const changed = await this.#socketLock.runInLock(ctx, async () => {
            const before = this.#status;
            const deviceOwners = await queryMobileDeviceOwners(ctx);
            const wanted =
                !this.#closed &&
                this.#config.mobileConnectorEnabled &&
                (deviceOwners.length > 0 ||
                    this.#linger !== undefined ||
                    [...this.#pairings.values()].some((pairing) => pairing.active));
            if (!this.#config.mobileConnectorEnabled) {
                await this.#closeSocket();
                this.#status = "disabled";
            } else if (!wanted) {
                await this.#closeSocket();
                this.#status = "closed";
                this.#error = null;
            } else if (this.#exposure === undefined) {
                this.#status = "starting";
                this.#error = null;
                this.#announce(ctx, this.#owners(deviceOwners));
                try {
                    await this.#openSocket(ctx);
                    this.#status = "open";
                } catch (error: unknown) {
                    await this.#closeSocket();
                    this.#status = "failed";
                    this.#error = errorMessage(error);
                }
            }
            return before === this.#status && this.#status !== "failed" ? undefined : deviceOwners;
        });
        if (changed !== undefined) this.#announce(ctx, this.#owners(changed));
        if (this.#status === "failed") throw new Error(this.#error ?? "The socket failed.");
    }

    async #openSocket(ctx: Context): Promise<void> {
        const listener = await startMobileListener(
            async (request, response) => await this.#handle(request, response),
        );
        this.#listener = listener;
        this.#exposure = await this.#tailcat.openExposure(ctx, {
            name: TAILCAT_EXPOSURE,
            port: this.#config.mobileConnectorPort,
            target: { host: "127.0.0.1", port: listener.port },
        });
    }

    async #closeSocket(): Promise<void> {
        const exposure = this.#exposure;
        const listener = this.#listener;
        this.#exposure = undefined;
        this.#listener = undefined;
        await exposure?.close();
        await listener?.close();
        this.#deviceSockets.clear();
    }

    // Phone-facing HTTP.

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", "http://mobile.invalid");
        try {
            if (this.#closed) throw new MobileConnectorError("unsupported", "Shutting down.");
            if (url.pathname.startsWith(PAIRING_PREFIX)) {
                await this.#handlePairing(request, response, url);
                return;
            }
            await this.#handleDevice(request, response);
        } catch (error: unknown) {
            if (response.headersSent) {
                response.destroy();
                return;
            }
            if (error instanceof MobileConnectorError) {
                sendMobileJson(response, error.status, { error: error.message, code: error.code });
                return;
            }
            this.#moduleContext().log.warn("A mobile request failed.", {}, error);
            sendMobileJson(response, 500, { error: "Internal error.", code: "internal" });
        }
    }

    async #handlePairing(request: IncomingMessage, response: ServerResponse, url: URL) {
        const ctx = this.#requestContext();
        const route = url.pathname.slice(PAIRING_PREFIX.length);
        if (request.method === "GET" && Value.Check(handshakeIdSchema, route)) {
            sendMobileJson(response, 200, await this.#phoneStatus(request, route, url));
            return;
        }
        if (request.method !== "POST") {
            throw new MobileConnectorError("not_found", "Not found.");
        }
        const body = await readMobileJsonBody(request);
        if (route === "start") {
            if (!Value.Check(pairingStartRequestSchema, body)) throw invalidRequest();
            sendMobileJson(response, 200, await this.#phoneStart(ctx, body));
            return;
        }
        if (route === "reveal") {
            if (!Value.Check(pairingRevealRequestSchema, body)) throw invalidRequest();
            sendMobileJson(response, 200, await this.#phoneReveal(ctx, body));
            return;
        }
        if (route === "confirm") {
            if (!Value.Check(pairingConfirmRequestSchema, body)) throw invalidRequest();
            sendMobileJson(response, 200, await this.#phoneConfirm(ctx, body));
            return;
        }
        if (route === "reject") {
            if (!Value.Check(pairingRejectRequestSchema, body)) throw invalidRequest();
            sendMobileJson(response, 200, await this.#phoneReject(ctx, body.handshakeId));
            return;
        }
        throw new MobileConnectorError("not_found", "Not found.");
    }

    async #phoneStart(
        ctx: Context,
        body: {
            readonly token: string;
            readonly commitment: string;
            readonly device: {
                readonly name: string;
                readonly platform: "ios" | "android" | "other";
            };
        },
    ) {
        const tokenHash = createHash("sha256")
            .update(Buffer.from(body.token, "base64url"))
            .digest("hex");
        const started = await this.#pairingLock.runInLock(ctx, async () => {
            const pairing = this.#byToken.get(tokenHash);
            // Consumed at first use, whatever happens next: a leaked code gets one attempt.
            this.#byToken.delete(tokenHash);
            if (pairing === undefined || this.#expireIfDue(pairing) || !pairing.active) {
                return undefined;
            }
            const answer = pairing.start(Buffer.from(body.commitment, "base64url"), {
                name: body.device.name,
                platform: body.device.platform,
            });
            this.#byHandshake.set(answer.handshakeId, pairing);
            return { pairing, answer };
        });
        if (started === undefined) {
            throw new MobileConnectorError("not_found", "This pairing code is no longer valid.");
        }
        this.#announce(ctx, [started.pairing.owner]);
        return started.answer;
    }

    async #phoneReveal(
        ctx: Context,
        body: { readonly handshakeId: string; readonly publicKey: string; readonly nonce: string },
    ): Promise<MobilePairingPhoneStatus> {
        const pairing = await this.#pairingLock.runInLock(ctx, async () => {
            const current = this.#handshake(body.handshakeId);
            if (!current.active) return current;
            if (current.snapshot().status !== "waiting") {
                throw new MobileConnectorError("conflict", "This pairing already has the key.");
            }
            const exposure = this.#exposure;
            if (exposure === undefined) {
                current.end("failed", "The phone connection socket closed.");
            } else {
                current.reveal(
                    Buffer.from(body.publicKey, "base64url"),
                    Buffer.from(body.nonce, "base64url"),
                    exposure.address,
                    exposure.port,
                );
            }
            if (!current.active) this.#release(current);
            return current;
        });
        this.#announce(ctx, [pairing.owner]);
        return pairing.phoneStatus();
    }

    async #phoneConfirm(
        ctx: Context,
        body: { readonly handshakeId: string; readonly mac: string },
    ): Promise<MobilePairingPhoneStatus> {
        const pairing = await this.#pairingLock.runInLock(ctx, async () => {
            const current = this.#handshake(body.handshakeId);
            if (!current.active) return current;
            if (current.snapshot().status !== "verifying") {
                throw new MobileConnectorError(
                    "conflict",
                    "This pairing is not waiting for emoji confirmation.",
                );
            }
            current.confirmMobile(Buffer.from(body.mac, "base64url"));
            if (!current.active) {
                this.#release(current);
                return current;
            }
            await this.#completeIfReady(ctx, current);
            return current;
        });
        this.#announce(ctx, [pairing.owner]);
        return pairing.phoneStatus();
    }

    async #phoneReject(ctx: Context, handshakeId: string): Promise<MobilePairingPhoneStatus> {
        const pairing = await this.#pairingLock.runInLock(ctx, async () => {
            const current = this.#handshake(handshakeId);
            if (!current.active) return current;
            current.end("rejected");
            this.#release(current);
            return current;
        });
        this.#announce(ctx, [pairing.owner]);
        return pairing.phoneStatus();
    }

    /** Long-poll: answer once the pairing changes, or after `wait` seconds at most. */
    async #phoneStatus(
        request: IncomingMessage,
        handshakeId: string,
        url: URL,
    ): Promise<MobilePairingPhoneStatus> {
        const pairing = this.#byHandshake.get(handshakeId);
        if (pairing === undefined) {
            throw new MobileConnectorError("not_found", "This pairing is no longer known.");
        }
        const wait = Number(url.searchParams.get("wait") ?? "0");
        const seconds = Number.isInteger(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_SECONDS) : 0;
        if (pairing.phoneStatus().status === "verifying") {
            const aborted = new AbortController();
            request.once("close", () => aborted.abort());
            await pairing.waitForChange(seconds * 1_000, aborted.signal);
        }
        this.#expireIfDue(pairing);
        return pairing.phoneStatus();
    }

    async #handleDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const authorization = request.headers.authorization;
        const match =
            typeof authorization === "string" ? DEVICE_TOKEN_PATTERN.exec(authorization) : null;
        const token = match?.[1];
        if (token === undefined) throw unauthorized();
        const ctx = this.#requestContext();
        const tokenHash = createHash("sha256")
            .update(Buffer.from(token, "base64url"))
            .digest("hex");
        const stored = await queryMobileDeviceByTokenHash(ctx, tokenHash);
        if (stored === undefined) throw unauthorized();
        const deviceId = stored.device.id;
        let sockets = this.#deviceSockets.get(deviceId);
        if (sockets === undefined) {
            sockets = new Set();
            this.#deviceSockets.set(deviceId, sockets);
        }
        const socket = request.socket;
        const tracked = sockets;
        tracked.add(socket);
        socket.once("close", () => tracked.delete(socket));
        await this.#touch(ctx, stored.owner, deviceId);
        const handler = this.#deviceHandler;
        if (handler === undefined) {
            throw new MobileConnectorError(
                "unsupported",
                "This computer does not serve phone requests yet.",
            );
        }
        await handler(ctx, { deviceId, owner: stored.owner }, request, response);
    }

    /** Record that a device was seen, at most once a minute. */
    async #touch(ctx: Context, owner: MobileOwner, deviceId: string): Promise<void> {
        const now = Date.now();
        const last = this.#lastTouched.get(deviceId);
        if (last !== undefined && now - last < LAST_SEEN_INTERVAL_MS) return;
        this.#lastTouched.set(deviceId, now);
        if (await touchMobileDevice(ctx, deviceId, now, LAST_SEEN_INTERVAL_MS)) {
            this.#announce(ctx, [owner]);
        }
    }

    // Pairing bookkeeping. Every caller holds the pairing lock.

    /** The pairing a phone is talking about, expired first if its time is up; 404 if unknown. */
    #handshake(handshakeId: string): MobilePairing {
        const pairing = this.#byHandshake.get(handshakeId);
        if (pairing === undefined) {
            throw new MobileConnectorError("not_found", "This pairing is no longer known.");
        }
        this.#expireIfDue(pairing);
        return pairing;
    }

    /**
     * Persist the device once both people confirmed. The row joins the caller's transaction, and
     * only after it commits does the pairing complete and prove itself to the phone. A rollback
     * leaves the pairing verifying with its completion claimed, so it ends by expiry or cancel.
     */
    async #completeIfReady(ctx: Context, pairing: MobilePairing): Promise<void> {
        const completion = pairing.beginCompletion();
        if (completion === undefined) return;
        const now = Date.now();
        const device = {
            id: createId(),
            name: completion.device.name,
            platform: completion.device.platform,
            createdAt: now,
            lastSeenAt: now,
        };
        await ctx.inTx(async (txCtx) => {
            await insertMobileDevice(txCtx, pairing.owner, device, completion.tokenHash);
            await this.#scheduleReconcile(txCtx);
            afterCommit(txCtx, async () => {
                if (pairing.complete(device.id)) {
                    this.#lastTouched.set(device.id, now);
                    this.#release(pairing);
                    return;
                }
                // The pairing ended before this commit was seen, so the phone never receives
                // the proof it needs to keep the token. A device nobody can use must not remain.
                await this.#moduleContext().inTx(async (cleanupCtx) => {
                    await deleteMobileDevice(cleanupCtx, pairing.owner, device.id);
                    await this.#scheduleReconcile(cleanupCtx);
                });
            });
        });
    }

    #expireIfDue(pairing: MobilePairing): boolean {
        if (!pairing.active || !pairing.isExpired(Date.now())) return false;
        pairing.end("expired");
        this.#release(pairing);
        return true;
    }

    async #expire(pairing: MobilePairing): Promise<void> {
        const ctx = this.#moduleContext();
        const expired = await this.#pairingLock.runInLock(ctx, async () => {
            if (!pairing.active) return false;
            pairing.end("expired");
            this.#release(pairing);
            return true;
        });
        if (expired) this.#announce(ctx, [pairing.owner]);
    }

    /** End a replaced pairing and forget it entirely. */
    #dismiss(pairing: MobilePairing | undefined, ending: "cancelled"): void {
        if (pairing === undefined) return;
        pairing.end(ending);
        this.#forget(pairing);
    }

    /**
     * A pairing that can no longer progress stops answering its token, its timer stops, and the
     * socket closes after a short linger if nothing else needs it.
     */
    #release(pairing: MobilePairing): void {
        this.#byToken.delete(pairing.tokenHash);
        const timer = this.#expiries.get(pairing);
        if (timer !== undefined) clearTimeout(timer);
        this.#expiries.delete(pairing);
        if (this.#closed) return;
        if (this.#linger !== undefined) clearTimeout(this.#linger);
        this.#linger = setTimeout(() => {
            this.#linger = undefined;
            const ctx = this.#moduleContext();
            void this.#reconcile(ctx).catch(() => undefined);
        }, LINGER_MS);
        this.#linger.unref();
    }

    /**
     * Drop a pairing from the snapshot. Until then a finished pairing stays readable by its
     * handshake, so the phone can learn how it ended and read the daemon's proof.
     */
    #forget(pairing: MobilePairing): void {
        this.#release(pairing);
        if (this.#pairings.get(pairing.owner) === pairing) this.#pairings.delete(pairing.owner);
        const handshakeId = pairing.handshakeId;
        if (handshakeId !== undefined) this.#byHandshake.delete(handshakeId);
    }

    // Snapshots and events.

    #owner(ctx: Context): MobileOwner {
        if (!this.#team.enabled) return STANDALONE_MOBILE_OWNER;
        const user = teamUser(ctx);
        if (user === undefined) throw new TeamAuthenticationError();
        return user.id;
    }

    #owners(deviceOwners: readonly MobileOwner[]): MobileOwner[] {
        return [...new Set([...deviceOwners, ...this.#pairings.keys()])];
    }

    async #snapshotFor(ctx: Context, owner: MobileOwner): Promise<MobileConnectorSnapshot> {
        const versioned = this.#versions.get(owner) ?? this.#bump(owner);
        const snapshot: MobileConnectorSnapshot = {
            status: this.#config.mobileConnectorEnabled ? this.#status : "disabled",
            pairing: this.#pairings.get(owner)?.snapshot() ?? null,
            devices: [...(await queryMobileDevices(ctx, owner))],
            error: this.#status === "failed" ? this.#error : null,
            version: versioned.version,
            updatedAt: versioned.updatedAt,
        };
        if (!Value.Check(mobileConnectorSnapshotSchema, snapshot)) {
            throw new Error("The mobile connector produced an invalid snapshot.");
        }
        return snapshot;
    }

    #bump(owner: MobileOwner): { version: string; updatedAt: number } {
        const versioned = { version: this.#uuid(), updatedAt: Date.now() };
        this.#versions.set(owner, versioned);
        return versioned;
    }

    /** After the caller's transaction commits, version and deliver each owner's new snapshot. */
    #announce(ctx: Context, owners: Iterable<MobileOwner>): void {
        const affected = [...new Set(owners)];
        if (affected.length === 0) return;
        afterCommit(ctx, async () => {
            const eventCtx = this.#moduleContext(ctx);
            for (const owner of affected) {
                this.#bump(owner);
                if (this.#listeners.size === 0) continue;
                const mobileConnector = await this.#snapshotFor(eventCtx, owner);
                for (const listener of Array.from(this.#listeners)) {
                    try {
                        await listener(eventCtx, { owner, mobileConnector });
                    } catch (error: unknown) {
                        eventCtx.log.error("A mobile connector subscriber failed.", {}, error);
                    }
                }
            }
        });
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new MobileConnectorError("unsupported", "The mobile connector has stopped.");
        }
    }

    #requestContext(): Context {
        const root = this.#moduleContext();
        const request = withAgentDatabase(detach(root).named("mobile-request"), root.db);
        return root.lifetime === undefined ? request : withLifetime(request, root.lifetime);
    }

    #moduleContext(fallback?: Context): Context {
        const ctx = this.#ctx ?? fallback;
        if (ctx === undefined) throw new Error("The mobile connector has not started.");
        return ctx;
    }
}

function encodeQr(bundle: {
    readonly v: 1;
    readonly a: string;
    readonly p: number;
    readonly t: string;
    readonly n: string;
    readonly e: number;
}): string {
    return `happy://direct?${Buffer.from(JSON.stringify(bundle), "utf8").toString("base64url")}`;
}

function invalidRequest(): MobileConnectorError {
    return new MobileConnectorError("invalid_request", "The pairing request is malformed.");
}

function unauthorized(): MobileConnectorError {
    return new MobileConnectorError("unauthorized", "Unauthorized");
}

/** A displayable reason, with any Tailcat address removed because it carries the socket's key. */
function errorMessage(error: unknown): string {
    const value = (error instanceof Error ? error.message : String(error))
        .replace(/\btc[A-Za-z0-9_-]{16,}/gu, "[address]")
        .trim()
        .slice(0, 2_048);
    return value || "The phone connection socket failed to open.";
}
