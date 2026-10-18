import { createHash, randomBytes } from "node:crypto";

import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

// The phone is a test-only implementation written from API_MOBILE.md, independent of `impl/`.
import { commitment, parseQr, phoneKey, startPhonePairing } from "./support/fakePhone.js";
import {
    MobileConnectorError,
    type MobileConnectorSnapshot,
} from "../../sources/mobileConnector/index.js";
import { withTeamUser, type TeamUser } from "../../sources/team/index.js";
import { pendingCallCount } from "../durableFunctions/support/durableFunctionsHarness.js";
import {
    FAKE_TAILCAT_ADDRESS,
    mobileConnectorWorld,
    type MobileConnectorWorld,
} from "./support/mobileConnectorWorld.js";

const PORT = 24_791;
const worlds: MobileConnectorWorld[] = [];
const device = { name: "Test iPhone", platform: "ios" } as const;

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const world of worlds.splice(0).reverse()) await world.close();
});

async function world(options: Partial<Parameters<typeof mobileConnectorWorld>[0]> = {}) {
    const created = await mobileConnectorWorld({ port: PORT, ...options });
    worlds.push(created);
    return created;
}

const baseUrl = `http://127.0.0.1:${String(PORT)}`;

async function request(
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

async function storedDevices(target: MobileConnectorWorld) {
    return await agentDatabaseRows<{ id: string; owner_id: string; token_hash: string }>(
        target.ctx.db,
        sql`SELECT id, owner_id, token_hash FROM happy_agent_mobile_devices`,
    );
}

async function waitForStatus(
    target: MobileConnectorWorld,
    status: MobileConnectorSnapshot["status"],
): Promise<void> {
    await vi.waitFor(
        async () => {
            expect((await target.mobile.snapshot(target.ctx)).status).toBe(status);
        },
        { timeout: 10_000 },
    );
}

async function pairedPhone(target: MobileConnectorWorld) {
    const started = await target.mobile.startPairing(target.ctx);
    const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
    await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
    return await session.confirm();
}

describe("MobileConnectorModule", () => {
    it("pairs a phone over its own Tailcat socket only after both people confirm", async () => {
        const target = await world();
        const initial = await target.mobile.snapshot(target.ctx);
        expect(initial).toMatchObject({
            status: "closed",
            pairing: null,
            devices: [],
            error: null,
        });

        const started = await target.mobile.startPairing(target.ctx);
        expect(started.status).toBe("open");
        expect(started.pairing).toMatchObject({ status: "waiting", device: null, emoji: null });
        const qr = parseQr(started.pairing!.qr!);
        expect(qr).toMatchObject({ v: 1, a: FAKE_TAILCAT_ADDRESS, p: PORT, n: "Test Mac" });
        expect(qr.e).toBe(started.pairing!.expiresAt);

        const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
        const verifying = await target.mobile.snapshot(target.ctx);
        expect(verifying.pairing).toMatchObject({
            status: "verifying",
            qr: null,
            device,
            emoji: session.emoji,
            desktopConfirmed: false,
            mobileConfirmed: false,
        });

        const confirmed = session.confirm();
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        expect(await storedDevices(target)).toEqual([]);
        await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
        const paired = await confirmed;

        expect(paired).toMatchObject({ address: FAKE_TAILCAT_ADDRESS, port: PORT });
        const rows = await storedDevices(target);
        expect(rows).toEqual([
            {
                id: paired.deviceId,
                owner_id: "standalone",
                token_hash: createHash("sha256")
                    .update(Buffer.from(paired.deviceToken, "base64url"))
                    .digest("hex"),
            },
        ]);
        const done = await target.mobile.snapshot(target.ctx);
        expect(done.pairing).toMatchObject({ status: "completed", desktopConfirmed: true });
        expect(done.devices).toEqual([
            {
                id: paired.deviceId,
                name: "Test iPhone",
                platform: "ios",
                createdAt: expect.any(Number),
                lastSeenAt: expect.any(Number),
            },
        ]);
        const invocations = await import("node:fs/promises").then(({ readFile }) =>
            readFile(`${target.root}/tailcat-invocations`, "utf8"),
        );
        expect(invocations).toContain("mobile.private.json serve 24791");
        expect(invocations).not.toContain("default.private.json");
    });

    it("completes in either order of confirmation", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
        await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
        expect((await target.mobile.snapshot(target.ctx)).pairing?.desktopConfirmed).toBe(true);
        await expect(session.confirm()).resolves.toMatchObject({ address: FAKE_TAILCAT_ADDRESS });
        expect(await storedDevices(target)).toHaveLength(1);
    });

    it("accepts only device tokens on the mobile listener and serves them as their owner", async () => {
        const target = await world();
        const paired = await pairedPhone(target);

        await expect(request("/v0/health")).resolves.toEqual({
            status: 401,
            body: { error: "Unauthorized", code: "unauthorized" },
        });
        await expect(
            request("/v0/health", { token: randomBytes(32).toString("base64url") }),
        ).resolves.toMatchObject({ status: 401 });
        await expect(request("/v0/health", { token: "local-api-token" })).resolves.toMatchObject({
            status: 401,
        });
        await expect(request("/v0/health", { token: paired.deviceToken })).resolves.toMatchObject({
            status: 503,
            body: { code: "unsupported" },
        });

        const seen: unknown[] = [];
        target.mobile.serveDeviceRequests(async (_ctx, caller, incoming, response) => {
            seen.push({ ...caller, url: incoming.url });
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true }));
        });
        await expect(request("/v0/health", { token: paired.deviceToken })).resolves.toEqual({
            status: 200,
            body: { ok: true },
        });
        expect(seen).toEqual([
            { deviceId: paired.deviceId, owner: "standalone", url: "/v0/health" },
        ]);
    });

    it("lets a leaked code start once and never pair without the desktop person", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const attacker = await startPhonePairing(started.pairing!.qr!, baseUrl);
        await expect(startPhonePairing(started.pairing!.qr!, baseUrl)).rejects.toMatchObject({
            code: "not_found",
            status: 404,
        });

        const confirming = attacker.confirm();
        confirming.catch(() => undefined);
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        // The desktop person sees emoji that do not match their own phone and cancels.
        await target.mobile.cancelPairing(target.ctx, started.pairing!.id);
        await expect(confirming).rejects.toMatchObject({ code: "rejected" });
        expect(await storedDevices(target)).toEqual([]);
        const cancelled = await target.mobile.snapshot(target.ctx);
        expect(cancelled.pairing).toMatchObject({ status: "cancelled", emoji: attacker.emoji });
        await waitForStatus(target, "closed");

        // A second cancel dismisses the finished pairing; a third changes nothing.
        await target.mobile.cancelPairing(target.ctx, started.pairing!.id);
        await target.mobile.cancelPairing(target.ctx, started.pairing!.id);
        expect((await target.mobile.snapshot(target.ctx)).pairing).toBeNull();
    });

    it("leaves nothing behind when the phone says the emoji differ", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
        await session.reject();
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("rejected");
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await storedDevices(target)).toEqual([]);
        await waitForStatus(target, "closed");
    });

    it("fails a phone whose revealed key does not match its commitment", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const qr = parseQr(started.pairing!.qr!);
        const committed = phoneKey();
        const nonce = randomBytes(32);
        const start = await request("/mobile/v1/pairing/start", {
            body: {
                token: qr.t,
                commitment: commitment(committed.publicKey, nonce).toString("base64url"),
                device,
            },
        });
        expect(start.status).toBe(200);
        const handshakeId = (start.body as { handshakeId: string }).handshakeId;
        const other = phoneKey();
        await expect(
            request("/mobile/v1/pairing/reveal", {
                body: {
                    handshakeId,
                    publicKey: other.publicKey.toString("base64url"),
                    nonce: nonce.toString("base64url"),
                },
            }),
        ).resolves.toEqual({ status: 200, body: { status: "rejected" } });
        expect((await target.mobile.snapshot(target.ctx)).pairing).toMatchObject({
            status: "failed",
            error: "The phone's key did not match the one it committed to.",
        });
        await expect(request(`/mobile/v1/pairing/${handshakeId}`)).resolves.toEqual({
            status: 200,
            body: { status: "rejected" },
        });
    });

    it("fails a phone that sends the wrong confirmation MAC", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const qr = parseQr(started.pairing!.qr!);
        const keys = phoneKey();
        const nonce = randomBytes(32);
        const start = await request("/mobile/v1/pairing/start", {
            body: {
                token: qr.t,
                commitment: commitment(keys.publicKey, nonce).toString("base64url"),
                device,
            },
        });
        const handshakeId = (start.body as { handshakeId: string }).handshakeId;
        await request("/mobile/v1/pairing/reveal", {
            body: {
                handshakeId,
                publicKey: keys.publicKey.toString("base64url"),
                nonce: nonce.toString("base64url"),
            },
        });
        await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
        await expect(
            request("/mobile/v1/pairing/confirm", {
                body: { handshakeId, mac: randomBytes(32).toString("base64url") },
            }),
        ).resolves.toEqual({ status: 200, body: { status: "rejected" } });
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("failed");
        expect(await storedDevices(target)).toEqual([]);
    });

    it("expires a pairing that is not finished within five minutes", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1_000);
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).rejects.toMatchObject({ code: "conflict" });
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("expired");
        await expect(session.confirm()).rejects.toMatchObject({ code: "expired" });
        expect(await storedDevices(target)).toEqual([]);
    });

    it("completes only when the device row commits with the caller's transaction", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
        const confirming = session.confirm();
        confirming.catch(() => undefined);
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        await expect(
            target.ctx.inTx(async (txCtx) => {
                await target.mobile.confirmPairing(txCtx, started.pairing!.id);
                expect(await storedDevices({ ...target, ctx: txCtx })).toHaveLength(1);
                expect((await target.mobile.snapshot(txCtx)).pairing?.status).toBe("verifying");
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");
        expect(await storedDevices(target)).toEqual([]);
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("verifying");

        // The claimed completion cannot be repeated; the pairing ends by its deadline instead,
        // which the next access notices and the phone's waiting status read reports.
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).resolves.toMatchObject({ pairing: { status: "verifying" } });
        expect(await storedDevices(target)).toEqual([]);
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1_000);
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(confirming).rejects.toMatchObject({ code: "expired" });
        expect(await storedDevices(target)).toEqual([]);
    });

    it("removes the device again when the pairing ended before its commit was seen", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
        const confirming = session.confirm();
        confirming.catch(() => undefined);
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        await target.ctx.inTx(async (txCtx) => {
            await target.mobile.confirmPairing(txCtx, started.pairing!.id);
            await target.mobile.cancelPairing(txCtx, started.pairing!.id);
        });
        await expect(confirming).rejects.toMatchObject({ code: "rejected" });
        await vi.waitFor(async () => {
            expect(await storedDevices(target)).toEqual([]);
        });
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("cancelled");
    });

    it("replaces the previous pairing when a new one starts", async () => {
        const target = await world();
        const first = await target.mobile.startPairing(target.ctx);
        const second = await target.mobile.startPairing(target.ctx);
        expect(second.pairing?.id).not.toBe(first.pairing?.id);
        await expect(startPhonePairing(first.pairing!.qr!, baseUrl)).rejects.toMatchObject({
            code: "not_found",
        });
        await expect(
            target.mobile.confirmPairing(target.ctx, first.pairing!.id),
        ).rejects.toMatchObject({ code: "not_found" });
    });

    it("revokes a device, closing its live requests and then the unused socket", async () => {
        const target = await world();
        const paired = await pairedPhone(target);
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => {
            entered = resolve;
        });
        target.mobile.serveDeviceRequests(async (_ctx, _caller, _incoming, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(": open\n\n");
            entered();
            await new Promise(() => undefined);
        });
        const stream = await fetch(`${baseUrl}/v0/events`, {
            headers: { authorization: `Bearer ${paired.deviceToken}` },
        });
        const reader = stream.body!.getReader();
        await reader.read();
        await inside;

        const revoked = await target.mobile.revokeDevice(target.ctx, paired.deviceId);
        expect(revoked.devices).toEqual([]);
        await expect(
            (async () => {
                while (!(await reader.read()).done);
            })(),
        ).rejects.toThrow();
        await waitForStatus(target, "closed");
        await expect(target.mobile.revokeDevice(target.ctx, paired.deviceId)).rejects.toThrow(
            MobileConnectorError,
        );
    });

    it("joins its caller's transaction when revoking, so a rollback keeps the device", async () => {
        const target = await world();
        const paired = await pairedPhone(target);
        const announced = target.events.length;
        await expect(
            target.ctx.inTx(async (txCtx) => {
                await target.mobile.revokeDevice(txCtx, paired.deviceId);
                expect(await pendingCallCount(txCtx)).toBe(1);
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");
        expect(await storedDevices(target)).toHaveLength(1);
        expect(await pendingCallCount(target.ctx)).toBe(0);
        expect(
            target.events
                .slice(announced)
                .some((event) => event.mobileConnector.devices.length === 0),
        ).toBe(false);
        target.mobile.serveDeviceRequests(async (_ctx, _caller, _incoming, response) => {
            response.writeHead(204);
            response.end();
        });
        const response = await fetch(`${baseUrl}/v0/health`, {
            headers: { authorization: `Bearer ${paired.deviceToken}` },
        });
        expect(response.status).toBe(204);
    });

    it("reopens the socket at startup when devices exist and keeps their tokens working", async () => {
        const first = await world();
        const paired = await pairedPhone(first);
        await first.stop();
        await expect(request("/v0/health", { token: paired.deviceToken })).rejects.toThrow();

        const restarted = await mobileConnectorWorld({ port: PORT, after: first });
        worlds.push({ ...restarted, close: restarted.stop });
        await waitForStatus(restarted, "open");
        restarted.mobile.serveDeviceRequests(async (_ctx, _caller, _incoming, response) => {
            response.writeHead(204);
            response.end();
        });
        const response = await fetch(`${baseUrl}/v0/health`, {
            headers: { authorization: `Bearer ${paired.deviceToken}` },
        });
        expect(response.status).toBe(204);
        expect((await restarted.mobile.snapshot(restarted.ctx)).pairing).toBeNull();
    });

    it("announces each owner's snapshots with increasing versions", async () => {
        const target = await world();
        await pairedPhone(target);
        await vi.waitFor(() => {
            expect(target.events.at(-1)?.mobileConnector.pairing?.status).toBe("completed");
        });
        const versions = target.events.map((event) => event.mobileConnector.version);
        expect(target.events.every((event) => event.owner === "standalone")).toBe(true);
        expect([...versions].sort()).toEqual(versions);
        expect(new Set(versions).size).toBe(versions.length);
        expect(target.events.map((event) => event.mobileConnector.pairing?.status)).toEqual(
            expect.arrayContaining(["waiting", "verifying", "completed"]),
        );
    });

    it("refuses to pair while the feature is turned off", async () => {
        const target = await world({ enabled: false });
        expect((await target.mobile.snapshot(target.ctx)).status).toBe("disabled");
        await expect(target.mobile.startPairing(target.ctx)).rejects.toMatchObject({
            code: "unsupported",
            status: 503,
        });
    });

    it("keeps each team member's pairing and devices to themselves", async () => {
        const target = await world({ team: true });
        const alice = member(target.ctx, "alice0000000000000000001");
        const bob = member(target.ctx, "bob00000000000000000000002");
        await expect(target.mobile.snapshot(target.ctx)).rejects.toThrow();
        const started = await target.mobile.startPairing(alice);
        const session = await startPhonePairing(started.pairing!.qr!, baseUrl);
        await expect(target.mobile.confirmPairing(bob, started.pairing!.id)).rejects.toMatchObject({
            code: "not_found",
        });
        await target.mobile.confirmPairing(alice, started.pairing!.id);
        const paired = await session.confirm();
        expect((await target.mobile.snapshot(bob)).devices).toEqual([]);
        expect((await target.mobile.snapshot(bob)).pairing).toBeNull();
        expect((await target.mobile.snapshot(alice)).devices).toHaveLength(1);
        await expect(target.mobile.revokeDevice(bob, paired.deviceId)).rejects.toMatchObject({
            code: "not_found",
        });
        expect((await storedDevices(target))[0]?.owner_id).toBe("alice0000000000000000001");
    });
});

function member(ctx: MobileConnectorWorld["ctx"], id: string) {
    return withTeamUser(ctx, {
        id,
        authentication: "workos",
        subject: `user_${id}`,
        firstName: "Test",
        lastName: null,
        email: `${id}@example.com`,
        isOwner: false,
        photo: null,
        createdAt: 0,
        updatedAt: 0,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    } as TeamUser);
}
