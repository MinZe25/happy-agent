import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { Value } from "@sinclair/typebox/value";
import { peerFrameSchema, type PeerFrame, type PeerMessage } from "./PeerProtocol.js";
import { stableId } from "./stableId.js";

export const PEER_DEADLINE = 10000;
export const PEER_MAX_FRAME = 128 * 1024;
const MAX_PENDING = 32;
const MAX_BUFFER = 1024 * 1024;
type Pending = {
    messageId: string | undefined;
    resolve: () => void;
    reject: () => void;
    timer: NodeJS.Timeout;
    cleanup: () => void;
};

/** One bounded, full-duplex session. It never queues or replays a failed message. */
export class PeerSession {
    readonly ready: Promise<void>;
    readonly closed: Promise<void>;
    readonly #socket: WebSocket;
    readonly #localId: string;
    readonly #peerId: string;
    readonly #incoming: boolean;
    readonly #receive: (message: PeerMessage, signal: AbortSignal) => Promise<void>;
    readonly #pending = new Map<string, Pending>();
    readonly #inbound = new Set<AbortController>();
    readonly #tasks = new Set<Promise<void>>();
    readonly #lifetime = new AbortController();
    readonly #handshakeTimer: NodeJS.Timeout;
    #heartbeat: NodeJS.Timeout | undefined;
    #resolveReady!: () => void;
    #rejectReady!: () => void;
    #resolveClosed!: () => void;
    #sessionId: string | null;
    #ready = false;
    #closed = false;

    constructor(
        socket: WebSocket,
        localId: string,
        peerId: string,
        incoming: boolean,
        receive: (message: PeerMessage, signal: AbortSignal) => Promise<void>,
    ) {
        this.#socket = socket;
        this.#localId = localId;
        this.#peerId = peerId;
        this.#incoming = incoming;
        this.#receive = receive;
        this.#sessionId = incoming ? stableId(randomUUID()) : null;
        this.ready = new Promise((resolve, reject) => {
            this.#resolveReady = resolve;
            this.#rejectReady = () => reject(new Error("The peer session did not authenticate."));
        });
        // Inbound ownership observes ready asynchronously; rejection must never escape meanwhile.
        void this.ready.catch(() => undefined);
        this.closed = new Promise((resolve) => {
            this.#resolveClosed = resolve;
        });
        this.#handshakeTimer = setTimeout(() => this.close(), PEER_DEADLINE);
        this.#handshakeTimer.unref();
        socket.on("message", (data, binary) => this.#frame(data, binary));
        socket.on(
            "pong",
            (data) =>
                this.#pending.get(data.toString())?.messageId === undefined &&
                this.#finish(data.toString(), true),
        );
        socket.on("error", () => this.close());
        socket.on("close", () => this.close());
        socket.on("ping", (data) => {
            if (this.#socket.bufferedAmount + data.byteLength + 14 > MAX_BUFFER) {
                this.close();
                return;
            }
            try {
                this.#socket.pong(data, undefined, (error) => {
                    if (error) this.close();
                });
            } catch {
                this.close();
            }
        });
        if (incoming)
            this.#write({
                type: "hello",
                version: 1,
                nodeId: localId,
                sessionId: this.#sessionId!,
            });
    }
    get connected(): boolean {
        return this.#ready && !this.#closed && this.#socket.readyState === WebSocket.OPEN;
    }
    get sessionId(): string | null {
        return this.connected ? this.#sessionId : null;
    }

    async ping(signal?: AbortSignal): Promise<void> {
        const requestId = stableId(randomUUID());
        if (this.#socket.bufferedAmount + Buffer.byteLength(requestId) + 14 > MAX_BUFFER)
            throw new Error("The peer session is saturated.");
        await this.#request(
            requestId,
            undefined,
            () =>
                this.#socket.ping(requestId, undefined, (error) => {
                    if (error) this.close();
                }),
            signal,
        );
    }
    async send(message: PeerMessage, signal?: AbortSignal): Promise<void> {
        const requestId = stableId(randomUUID());
        await this.#request(
            requestId,
            message.messageId,
            () => this.#write({ type: "message", requestId, message }),
            signal,
        );
    }
    async #request(
        id: string,
        messageId: string | undefined,
        write: () => void,
        signal?: AbortSignal,
    ): Promise<void> {
        if (
            !this.connected ||
            this.#pending.size >= MAX_PENDING ||
            this.#socket.bufferedAmount > MAX_BUFFER ||
            signal?.aborted
        )
            throw new Error("The peer session is unavailable.");
        await new Promise<void>((resolve, reject) => {
            const cancelled = () => this.#finish(id, false);
            const timer = setTimeout(() => {
                this.#finish(id, false);
                this.close();
            }, PEER_DEADLINE);
            timer.unref();
            this.#pending.set(id, {
                messageId,
                resolve,
                reject: () => reject(new Error("The peer request was not acknowledged.")),
                timer,
                cleanup: () => signal?.removeEventListener("abort", cancelled),
            });
            signal?.addEventListener("abort", cancelled, { once: true });
            try {
                write();
            } catch {
                this.#finish(id, false);
            }
        });
    }
    #finish(id: string, success: boolean): void {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanup();
        if (success) pending.resolve();
        else pending.reject();
    }
    #frame(data: RawData, binary: boolean): void {
        if (this.#closed) return;
        if (binary) {
            this.close();
            return;
        }
        let frame: unknown;
        try {
            frame = JSON.parse(data.toString());
        } catch {
            this.close();
            return;
        }
        if (!Value.Check(peerFrameSchema, frame)) {
            this.close();
            return;
        }
        if (!this.#ready) {
            if (
                !this.#incoming &&
                frame.type === "hello" &&
                this.#sessionId === null &&
                frame.nodeId === this.#peerId
            ) {
                this.#sessionId = frame.sessionId;
                this.#write({
                    type: "ready",
                    version: 1,
                    nodeId: this.#localId,
                    sessionId: frame.sessionId,
                });
                return;
            }
            if (
                frame.type !== "ready" ||
                frame.nodeId !== this.#peerId ||
                frame.sessionId !== this.#sessionId
            ) {
                this.close();
                return;
            }
            if (this.#incoming)
                this.#write({
                    type: "ready",
                    version: 1,
                    nodeId: this.#localId,
                    sessionId: this.#sessionId!,
                });
            if (this.#closed) return;
            this.#ready = true;
            clearTimeout(this.#handshakeTimer);
            this.#resolveReady();
            this.#heartbeat = setInterval(() => {
                // Local saturation is not evidence that the peer is dead. Existing requests
                // still own their deadlines; heartbeat probes resume when capacity is free.
                if (
                    this.#pending.size >= MAX_PENDING ||
                    this.#socket.bufferedAmount + 40 > MAX_BUFFER
                )
                    return;
                void this.ping().catch(() => this.close());
            }, 30000);
            this.#heartbeat.unref();
            return;
        }
        if (frame.type === "ack") {
            const pending = this.#pending.get(frame.requestId);
            if (pending !== undefined && pending.messageId !== frame.messageId) {
                this.close();
                return;
            }
            this.#finish(frame.requestId, frame.accepted);
            return;
        }
        if (frame.type !== "message" || this.#inbound.size >= MAX_PENDING) {
            this.close();
            return;
        }
        const task = this.#admit(frame);
        this.#tasks.add(task);
        void task.catch(() => this.close()).finally(() => this.#tasks.delete(task));
    }
    async #admit(frame: Extract<PeerFrame, { type: "message" }>): Promise<void> {
        const abort = new AbortController();
        this.#inbound.add(abort);
        const timer = setTimeout(() => {
            abort.abort();
            this.close();
        }, PEER_DEADLINE);
        timer.unref();
        try {
            await this.#receive(
                frame.message,
                AbortSignal.any([abort.signal, this.#lifetime.signal]),
            );
            if (!this.#closed)
                this.#write({
                    type: "ack",
                    requestId: frame.requestId,
                    messageId: frame.message.messageId,
                    accepted: true,
                });
        } catch {
            if (!this.#closed)
                this.#write({
                    type: "ack",
                    requestId: frame.requestId,
                    messageId: frame.message.messageId,
                    accepted: false,
                    error: "The destination agent is unavailable or the message could not be admitted.",
                });
        } finally {
            clearTimeout(timer);
            this.#inbound.delete(abort);
        }
    }
    #write(frame: PeerFrame): void {
        const encoded = JSON.stringify(frame);
        if (
            this.#closed ||
            this.#socket.readyState !== WebSocket.OPEN ||
            this.#socket.bufferedAmount + Buffer.byteLength(encoded) + 14 > MAX_BUFFER
        ) {
            this.close();
            return;
        }
        try {
            this.#socket.send(encoded, (error) => {
                if (error) this.close();
            });
        } catch {
            this.close();
        }
    }
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#ready = false;
        clearTimeout(this.#handshakeTimer);
        if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
        this.#lifetime.abort();
        for (const abort of this.#inbound) abort.abort();
        for (const id of this.#pending.keys()) this.#finish(id, false);
        this.#rejectReady();
        this.#socket.terminate();
        this.#resolveClosed();
    }
    async drain(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
            Promise.allSettled(this.#tasks),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, PEER_DEADLINE);
            }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
    }
}
