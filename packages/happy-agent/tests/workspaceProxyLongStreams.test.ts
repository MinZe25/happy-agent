import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
    connect,
    createServer as createTcpServer,
    type AddressInfo,
    type Server,
    type Socket,
} from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { WorkspaceProxy } from "@slopus/happy-agent-modules";
import type { PreparedHappyAgentRuntime } from "@slopus/happy-agent-modules";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { bindNodeAgentHttpServer } from "../sources/socket/AgentSocket.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listening(server: Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
        async () =>
            await new Promise<void>((resolve) => {
                (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
                server.close(() => resolve());
            }),
    );
    return (server.address() as AddressInfo).port;
}

/**
 * The real Node front door with its own request timeouts, over a workspace whose network is a
 * connector to `networkPort`. Anything on this machine outside that network must stay untouched.
 */
async function frontDoor(networkPort: number): Promise<{ attach(): Promise<Socket> }> {
    const proxy = new WorkspaceProxy();
    cleanups.push(async () => await proxy.close());
    const root = createRootContext().named("workspace-proxy-long-streams");
    const prepared = {
        context: () => root,
        api: {
            handleRequest: async (
                _ctx: unknown,
                _request: IncomingMessage,
                response: ServerResponse,
            ) => response.end("healthy"),
            handleUpgrade: async () => false,
            handleConnect: async (
                _ctx: unknown,
                _request: IncomingMessage,
                socket: Socket,
                head: Buffer,
            ) => {
                const route = proxy.route(async () => {
                    const upstream = connect({
                        host: "127.0.0.1",
                        port: networkPort,
                        allowHalfOpen: true,
                    });
                    await once(upstream, "connect");
                    return upstream;
                });
                proxy.accept(socket, head, route);
                return true;
            },
        },
    } as unknown as PreparedHappyAgentRuntime;
    const listener = await bindNodeAgentHttpServer(prepared, "127.0.0.1", 0);
    cleanups.push(async () => await listener.close());
    return {
        async attach() {
            const socket = connect({ host: "127.0.0.1", port: listener.port, allowHalfOpen: true });
            cleanups.push(() => void socket.destroy());
            await once(socket, "connect");
            socket.write(
                "CONNECT /v0/workspaces/w/agents/a/proxy HTTP/1.1\r\nHost: daemon\r\nAuthorization: Bearer fixture\r\n\r\n",
            );
            const [answer] = (await once(socket, "data")) as [Buffer];
            expect(answer.toString("latin1")).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
            return socket;
        },
    };
}

async function readAll(socket: Socket): Promise<string> {
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
    await new Promise<void>((resolve) => {
        socket.once("end", () => resolve());
        socket.once("close", () => resolve());
    });
    return text;
}

describe("workspace proxy through the Node front door", () => {
    it("keeps server-sent events and a slow upload flowing past 30 seconds", async () => {
        let uploaded = 0;
        const app = createServer((request, response) => {
            if (request.url === "/events") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                let sent = 0;
                const timer = setInterval(() => {
                    response.write(`data: ${String(sent)}\n\n`);
                    sent += 1;
                    if (sent === 34) {
                        clearInterval(timer);
                        response.end();
                    }
                }, 1_000);
                request.once("close", () => clearInterval(timer));
                return;
            }
            request.on("data", (chunk: Buffer) => (uploaded += chunk.byteLength));
            request.once("end", () => response.end(`received ${String(uploaded)}`));
        });
        const f = await frontDoor(await listening(app));

        const events = await f.attach();
        const streamed = readAll(events);
        events.write(
            "GET http://localhost:3000/events HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n",
        );

        const upload = await f.attach();
        const answered = readAll(upload);
        upload.write(
            "POST http://localhost:3000/upload HTTP/1.1\r\nHost: localhost:3000\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        );
        const started = Date.now();
        for (let second = 0; second < 33; second += 1) {
            upload.write("400\r\n" + "u".repeat(1024) + "\r\n");
            await sleep(1_000);
        }
        upload.write("0\r\n\r\n");

        expect(await answered).toContain(`received ${String(33 * 1024)}`);
        const text = await streamed;
        expect(Date.now() - started).toBeGreaterThan(32_000);
        expect(text).toContain("data: 0\n\n");
        expect(text).toContain("data: 33\n\n");
    }, 60_000);

    it("delivers a reply sent after the client half-closes its tunnel", async () => {
        const app = createTcpServer({ allowHalfOpen: true }, (socket) => {
            let text = "";
            socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
            socket.once("end", () => setTimeout(() => socket.end(`late reply to ${text}`), 500));
        });
        const f = await frontDoor(await listening(app));
        const socket = await f.attach();
        socket.write("CONNECT localhost:3000 HTTP/1.1\r\nHost: localhost:3000\r\n\r\n");
        const [answer] = (await once(socket, "data")) as [Buffer];
        expect(answer.toString("latin1")).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
        const reply = readAll(socket);
        socket.end("upload");
        expect(await reply).toBe("late reply to upload");
    }, 10_000);

    it("closes the destination's request when the client goes away", async () => {
        let closed!: () => void;
        const destinationClosed = new Promise<void>((resolve) => (closed = resolve));
        const app = createServer((request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("data: first\n\n");
            request.once("close", () => closed());
        });
        const f = await frontDoor(await listening(app));
        const socket = await f.attach();
        socket.write("GET http://localhost:3000/events HTTP/1.1\r\nHost: localhost:3000\r\n\r\n");
        await new Promise<void>((resolve) => {
            let text = "";
            socket.on("data", (chunk: Buffer) => {
                text += chunk.toString();
                if (text.includes("data: first")) resolve();
            });
        });
        socket.destroy();
        await destinationClosed;
    }, 10_000);
});
