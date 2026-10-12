import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import type { HappyAgentClient } from "@slopus/happy-agent-client";
import { createNodeBinaryWebSocket, WebSocketDuplex } from "@slopus/happy-agent-modules/transport";
import WebSocket from "ws";

const MAX_TERMINAL_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;

export interface HappyAgentSocketTransport {
    readonly socketPath: string;
    readonly token: string;
}

/**
 * Attach to a terminal using the URL produced by the public client.
 *
 * This adapter owns only Unix-socket WebSocket framing. Terminal wire messages
 * remain opaque bytes to the gym scenarios.
 */
export function connectTerminalWebSocket(
    client: HappyAgentClient,
    workspaceId: string,
    terminalId: string,
    transport: HappyAgentSocketTransport,
): Promise<Duplex> {
    const endpoint = new URL(client.terminalAttachUrl(workspaceId, terminalId));
    return new Promise<Duplex>((resolve, reject) => {
        const webSocket = new WebSocket(
            `ws+unix://${transport.socketPath}:${endpoint.pathname}${endpoint.search}`,
            {
                handshakeTimeout: 10_000,
                headers: { authorization: `Bearer ${transport.token}` },
                maxPayload: MAX_TERMINAL_MESSAGE_BYTES,
                perMessageDeflate: false,
            },
        );
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            webSocket.terminate();
            reject(error);
        };
        webSocket.once("error", fail);
        webSocket.once("unexpected-response", (_request, response) => {
            response.resume();
            fail(
                new Error(
                    `Terminal WebSocket failed with HTTP ${String(response.statusCode ?? 500)}.`,
                ),
            );
        });
        webSocket.once("open", () => {
            if (settled) return;
            settled = true;
            webSocket.off("error", fail);
            resolve(new WebSocketDuplex(createNodeBinaryWebSocket(webSocket)));
        });
    });
}

/** A bridge WebSocket the daemon refused before upgrading, with its status and error body. */
export class BridgeUpgradeError extends Error {
    override readonly name = "BridgeUpgradeError";

    constructor(
        readonly status: number,
        readonly body: Record<string, unknown>,
    ) {
        super(`Bridge WebSocket failed with HTTP ${String(status)}.`);
    }
}

/** One message a bridge WebSocket received. */
export interface GymBridgeMessage {
    readonly binary: boolean;
    readonly data: Buffer;
}

/**
 * One open bridge WebSocket, holding every message and its close from the moment it opened.
 *
 * A bridge speaks as soon as its upgrade completes, often in the same packet, so a scenario that
 * attached its listener after awaiting the upgrade would miss the first message.
 */
export class GymBridgeWebSocket {
    readonly webSocket: WebSocket;
    /** How the WebSocket closed, whoever closed it. */
    readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
    readonly #messages: GymBridgeMessage[] = [];
    readonly #waiters = new Set<() => void>();
    #read = 0;

    constructor(webSocket: WebSocket) {
        this.webSocket = webSocket;
        webSocket.on("message", (data, binary) => {
            this.#messages.push({
                binary,
                data: Array.isArray(data)
                    ? Buffer.concat(data)
                    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data),
            });
            for (const waiter of this.#waiters) waiter();
        });
        this.closed = new Promise((resolve) => {
            webSocket.once("close", (code, reason) => {
                resolve({ code, reason: reason.toString() });
                for (const waiter of this.#waiters) waiter();
            });
        });
    }

    send(data: Uint8Array | string): void {
        this.webSocket.send(data);
    }

    close(): void {
        this.webSocket.close();
    }

    /** The next message not yet read, waiting for it to arrive. */
    async next(timeoutMs = 10_000): Promise<GymBridgeMessage> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const message = this.#messages[this.#read];
            if (message !== undefined) {
                this.#read += 1;
                return message;
            }
            if (this.webSocket.readyState === WebSocket.CLOSED) {
                throw new Error("The bridge WebSocket closed before another message arrived.");
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error("No bridge message arrived in time.");
            await new Promise<void>((resolve) => {
                const wake = (): void => {
                    clearTimeout(timer);
                    this.#waiters.delete(wake);
                    resolve();
                };
                const timer = setTimeout(wake, remaining);
                this.#waiters.add(wake);
            });
        }
    }

    /** The next message, which must be JSON text. */
    async nextJson(timeoutMs?: number): Promise<Record<string, unknown>> {
        const message = await this.next(timeoutMs);
        if (message.binary) throw new Error("The bridge sent binary where JSON text was expected.");
        return JSON.parse(message.data.toString("utf8")) as Record<string, unknown>;
    }
}

/**
 * Open one bridge WebSocket from a URL the public client built.
 *
 * Bridges carry both binary and JSON text messages and close with their own codes, so the
 * scenario gets every message and the close rather than a byte stream. A refused upgrade rejects
 * with a `BridgeUpgradeError` carrying the daemon's status and error body.
 */
export function connectBridgeWebSocket(
    url: string,
    transport: HappyAgentSocketTransport,
): Promise<GymBridgeWebSocket> {
    const endpoint = new URL(url);
    return new Promise<GymBridgeWebSocket>((resolve, reject) => {
        const webSocket = new WebSocket(
            `ws+unix://${transport.socketPath}:${endpoint.pathname}${endpoint.search}`,
            {
                handshakeTimeout: 10_000,
                headers: { authorization: `Bearer ${transport.token}` },
                maxPayload: 1024 * 1024,
                perMessageDeflate: false,
            },
        );
        const bridge = new GymBridgeWebSocket(webSocket);
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            webSocket.terminate();
            reject(error);
        };
        webSocket.once("error", fail);
        webSocket.once("unexpected-response", (_request, response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
                text += chunk;
            });
            response.once("end", () => {
                let body: Record<string, unknown> = {};
                try {
                    body = JSON.parse(text) as Record<string, unknown>;
                } catch {
                    // A body that is not JSON is reported by its status alone.
                }
                fail(new BridgeUpgradeError(response.statusCode ?? 500, body));
            });
        });
        webSocket.once("open", () => {
            if (settled) return;
            settled = true;
            webSocket.off("error", fail);
            // A failure after opening ends in a close the scenario observes instead.
            webSocket.on("error", () => undefined);
            resolve(bridge);
        });
    });
}

/**
 * Open the workspace's raw CONNECT tunnel using the public client's URL.
 *
 * The returned socket is the tunnel byte stream. Callers may speak HTTP or a
 * nested CONNECT protocol over it; this helper does not inspect either.
 */
export function connectWorkspaceProxy(
    client: HappyAgentClient,
    workspaceId: string,
    transport: HappyAgentSocketTransport,
): Promise<Duplex> {
    const endpoint = new URL(client.workspaceProxyUrl(workspaceId));
    return new Promise<Duplex>((resolve, reject) => {
        const request = httpRequest({
            headers: { authorization: `Bearer ${transport.token}` },
            method: "CONNECT",
            path: `${endpoint.pathname}${endpoint.search}`,
            socketPath: transport.socketPath,
        });
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            request.destroy();
            reject(error);
        };
        request.once("error", fail);
        request.once("response", (response) => {
            response.resume();
            fail(
                new Error(
                    `Workspace proxy failed with HTTP ${String(response.statusCode ?? 500)}.`,
                ),
            );
        });
        request.once("connect", (response, socket, head) => {
            if (settled) {
                socket.destroy();
                return;
            }
            if ((response.statusCode ?? 500) !== 200) {
                response.resume();
                fail(
                    new Error(
                        `Workspace proxy failed with HTTP ${String(response.statusCode ?? 500)}.`,
                    ),
                );
                socket.destroy();
                return;
            }
            settled = true;
            if (head.length > 0) socket.unshift(head);
            resolve(socket);
        });
        request.end();
    });
}
