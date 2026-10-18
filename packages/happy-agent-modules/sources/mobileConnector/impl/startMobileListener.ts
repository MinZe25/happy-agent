import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface MobileListener {
    readonly port: number;
    close(): Promise<void>;
}

/**
 * The phones' own loopback HTTP server. Tailcat's relay forwards to it, never to the main API
 * socket. It binds an ephemeral loopback port because the fixed, remembered port belongs to the
 * Tailcat relay in front of it. Closing destroys every connection, long polls included.
 */
export async function startMobileListener(
    handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<MobileListener> {
    const sockets = new Set<Socket>();
    const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
        void handle(request, response).catch(() => {
            if (!response.headersSent) {
                response.writeHead(500, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "Internal error.", code: "internal" }));
            } else {
                response.destroy();
            }
        });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 60_000;
    server.keepAliveTimeout = 30_000;
    server.maxConnections = 256;
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        server.close();
        throw new Error("The mobile listener has no loopback port.");
    }
    let closing: Promise<void> | undefined;
    return {
        port: address.port,
        close: () => {
            closing ??= new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            });
            return closing;
        },
    };
}

/** Read a small JSON body, or `undefined` when it is too large or not JSON. */
export async function readMobileJsonBody(
    request: IncomingMessage,
    limit = 16_384,
): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        if (size > limit) return undefined;
        chunks.push(bytes);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        return undefined;
    }
}

export function sendMobileJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(payload),
        "content-type": "application/json",
    });
    response.end(payload);
}
