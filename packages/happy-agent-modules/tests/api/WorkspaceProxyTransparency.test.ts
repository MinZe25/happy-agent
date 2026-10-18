import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
    createServer,
    request,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import {
    connect,
    createServer as createTcpServer,
    type AddressInfo,
    type Server,
    type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
    WORKSPACE_PROXY_ROUTE_HEADER,
    WorkspaceProxy,
    type WorkspaceProxyConnector,
} from "../../sources/api/WorkspaceProxy.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listening<T extends Server>(server: T, host = "127.0.0.1"): Promise<number> {
    server.listen(0, host);
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

function proxyWith(connectTimeoutMs?: number): WorkspaceProxy {
    const proxy = new WorkspaceProxy(connectTimeoutMs === undefined ? {} : { connectTimeoutMs });
    cleanups.push(async () => await proxy.close());
    return proxy;
}

/** Connects to a port on this machine, the way a workspace's own network would. */
function to(port: number): WorkspaceProxyConnector {
    return async () => {
        const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
        await once(socket, "connect");
        return socket;
    };
}

/**
 * An attachment as the Node API front door opens one: `CONNECT /v0/.../proxy` answered by
 * handing the socket to the proxy with the route its admission produced.
 */
async function attach(
    proxy: WorkspaceProxy,
    route: string,
): Promise<{ socket: Socket; status: string }> {
    const front = createServer();
    front.on("connect", (_request, socket: Socket, head: Buffer) =>
        proxy.accept(socket, head, route),
    );
    const port = await listening(front);
    const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    cleanups.push(() => void socket.destroy());
    await once(socket, "connect");
    socket.write("CONNECT /v0/workspaces/w/proxy HTTP/1.1\r\nHost: daemon\r\n\r\n");
    const [first] = (await once(socket, "data")) as [Buffer];
    const status = first.toString("latin1");
    const end = status.indexOf("\r\n\r\n") + 4;
    if (end < first.byteLength) socket.unshift(first.subarray(end));
    return { socket, status: status.slice(0, end) };
}

/** Speak one plain proxied request over an attachment, returning the response as raw text. */
async function readAll(socket: Duplex): Promise<string> {
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
    await Promise.race([once(socket, "end"), once(socket, "close")]);
    return text;
}

/** Settles once the stream closes, whether or not it was reset first. */
async function closed(stream: Duplex): Promise<void> {
    await new Promise<void>((resolve) => stream.once("close", () => resolve()));
}

/** Open a nested CONNECT on an attachment and wait for its answer line. */
async function tunnel(socket: Socket, authority: string): Promise<string> {
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const [answer] = (await once(socket, "data")) as [Buffer];
    const text = answer.toString("latin1");
    const end = text.indexOf("\r\n\r\n") + 4;
    if (end > 3 && end < answer.byteLength) socket.unshift(answer.subarray(end));
    return text.slice(0, Math.max(end, 0));
}

describe("workspace proxy transparency", () => {
    it("never connects from this machine without a valid route", async () => {
        const connections: Socket[] = [];
        const sentinel = createTcpServer((socket) => {
            connections.push(socket);
            socket.destroy();
        });
        const port = await listening(sentinel);
        const proxy = proxyWith();

        // An attachment whose route is unknown, expired, or already used is refused at once.
        const used = proxy.route(to(port));
        expect((await attach(proxy, used)).status).toMatch(/^HTTP\/1\.1 200 /u);
        expect((await attach(proxy, used)).status).toMatch(/^HTTP\/1\.1 502 /u);
        expect((await attach(proxy, "unknown-route")).status).toMatch(/^HTTP\/1\.1 502 /u);

        // The Bun hop: an admitted connection that presents no route, or a replayed one.
        const hop = await proxy.listenTcp();
        const replayed = proxy.route(to(port));
        const statuses: number[] = [];
        for (const route of [undefined, replayed, replayed]) {
            statuses.push(
                await new Promise<number>((resolve, reject) => {
                    const outgoing = request(
                        {
                            agent: false,
                            hostname: "127.0.0.1",
                            port: hop.port,
                            path: `http://127.0.0.1:${String(port)}/`,
                            headers: {
                                "proxy-authorization": hop.authorization,
                                ...(route === undefined
                                    ? {}
                                    : { [WORKSPACE_PROXY_ROUTE_HEADER]: route }),
                            },
                        },
                        (response) => {
                            response.resume();
                            response.once("end", () => resolve(response.statusCode ?? 0));
                        },
                    );
                    outgoing.on("error", reject);
                    outgoing.end();
                }),
            );
        }
        // The first replay reaches the sentinel through its route; nothing else reaches it.
        expect(statuses).toEqual([502, 502, 502]);
        expect(connections).toHaveLength(1);

        const bare = connect(hop.port, "127.0.0.1");
        cleanups.push(() => void bare.destroy());
        await once(bare, "connect");
        const reply = readAll(bare);
        bare.write(
            `CONNECT 127.0.0.1:${String(port)} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${hop.authorization}\r\n\r\n`,
        );
        expect(await reply).toMatch(/^HTTP\/1\.1 502 /u);
        expect(connections).toHaveLength(1);
    });

    it("delivers the client's own headers and adds none of its own", async () => {
        const seen: IncomingHttpHeaders[] = [];
        const target = createServer((incoming, response) => {
            seen.push(incoming.headers);
            response.writeHead(200, { "set-cookie": "site=1", "content-length": "2" });
            response.end("ok");
        });
        const port = await listening(target);
        const proxy = proxyWith();
        const { socket } = await attach(proxy, proxy.route(to(port)));
        const reply = readAll(socket);
        socket.write(
            [
                `GET http://localhost:${String(port)}/page HTTP/1.1`,
                `Host: localhost:${String(port)}`,
                "Authorization: Bearer site-token",
                "Cookie: session=abc",
                "Proxy-Authorization: Basic secret",
                "Proxy-Connection: keep-alive",
                `${WORKSPACE_PROXY_ROUTE_HEADER}: forged`,
                "User-Agent: Mozilla/5.0 Test",
                "Connection: close",
                "",
                "",
            ].join("\r\n"),
        );
        const text = await reply;
        expect(text).toMatch(/^HTTP\/1\.1 200 /u);
        expect(text.toLowerCase()).toContain("set-cookie: site=1");
        expect(seen).toHaveLength(1);
        const headers = seen[0]!;
        expect(headers).toMatchObject({
            host: `localhost:${String(port)}`,
            authorization: "Bearer site-token",
            cookie: "session=abc",
            "user-agent": "Mozilla/5.0 Test",
        });
        for (const name of [
            "proxy-authorization",
            "proxy-connection",
            WORKSPACE_PROXY_ROUTE_HEADER,
            "via",
            "forwarded",
            "x-forwarded-for",
        ])
            expect(headers[name]).toBeUndefined();
    });

    it("streams events and uploads far past the bound on opening a connection", async () => {
        const bound = 200;
        let uploaded = 0;
        const target = createServer((incoming: IncomingMessage, response: ServerResponse) => {
            if (incoming.url === "/events") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                let sent = 0;
                const timer = setInterval(() => {
                    response.write(`data: ${String(sent)}\n\n`);
                    sent += 1;
                    if (sent === 15) {
                        clearInterval(timer);
                        response.end();
                    }
                }, 100);
                incoming.once("close", () => clearInterval(timer));
                return;
            }
            incoming.on("data", (chunk: Buffer) => (uploaded += chunk.byteLength));
            incoming.once("end", () => response.end(`received ${String(uploaded)}`));
        });
        const port = await listening(target);
        const proxy = proxyWith(bound);

        const events = await attach(proxy, proxy.route(to(port)));
        const eventText = readAll(events.socket);
        events.socket.write(
            `GET http://localhost:${String(port)}/events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
        );

        const upload = await attach(proxy, proxy.route(to(port)));
        const uploadText = readAll(upload.socket);
        upload.socket.write(
            `POST http://localhost:${String(port)}/upload HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
        );
        const started = Date.now();
        for (let index = 0; index < 15; index += 1) {
            upload.socket.write("400\r\n" + "u".repeat(1024) + "\r\n");
            await sleep(100);
        }
        upload.socket.write("0\r\n\r\n");

        const streamed = await eventText;
        expect(Date.now() - started).toBeGreaterThan(bound * 5);
        for (let index = 0; index < 15; index += 1) expect(streamed).toContain(`data: ${index}`);
        expect(await uploadText).toContain(`received ${String(15 * 1024)}`);
    });

    it("bounds how long headers take on both listeners, but never a body", async () => {
        const bound = 300;
        const target = createServer((incoming: IncomingMessage, response: ServerResponse) => {
            let uploaded = 0;
            incoming.on("data", (chunk: Buffer) => (uploaded += chunk.byteLength));
            incoming.once("end", () => response.end(`received ${String(uploaded)}`));
        });
        const port = await listening(target);
        const proxy = new WorkspaceProxy({ headersTimeoutMs: bound });
        cleanups.push(async () => await proxy.close());
        const directory = await mkdtemp(join(tmpdir(), "happy-proxy-"));
        cleanups.push(async () => await rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "p.sock");
        await proxy.listen(socketPath);
        const hop = await proxy.listenTcp();

        for (const [listener, admission] of [
            [{ path: socketPath }, ""],
            [
                { host: "127.0.0.1", port: hop.port },
                `Proxy-Authorization: ${hop.authorization}\r\n`,
            ],
        ] as const) {
            const stalled = connect(listener);
            cleanups.push(() => void stalled.destroy());
            await once(stalled, "connect");
            const refused = readAll(stalled);
            const started = Date.now();
            stalled.write(`GET http://127.0.0.1:${String(port)}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n`);
            expect(await refused).toMatch(/^HTTP\/1\.1 408 /u);
            expect(Date.now() - started).toBeGreaterThanOrEqual(bound);

            const upload = connect(listener);
            cleanups.push(() => void upload.destroy());
            await once(upload, "connect");
            const received = readAll(upload);
            upload.write(
                `POST http://127.0.0.1:${String(port)}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n${admission}` +
                    `${WORKSPACE_PROXY_ROUTE_HEADER}: ${proxy.route(to(port))}\r\n` +
                    "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            );
            for (let index = 0; index < 8; index += 1) {
                upload.write("400\r\n" + "u".repeat(1024) + "\r\n");
                await sleep(bound / 2);
            }
            upload.write("0\r\n\r\n");
            expect(await received).toContain(`received ${String(8 * 1024)}`);
        }
    });

    it("answers 504 only while a connection is still being opened", async () => {
        const proxy = proxyWith(100);
        const never: WorkspaceProxyConnector = async () => await new Promise<Duplex>(() => {});
        const plain = await attach(proxy, proxy.route(never));
        const plainReply = readAll(plain.socket);
        plain.socket.write(
            "GET http://localhost:3000/ HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n",
        );
        expect(await plainReply).toMatch(/^HTTP\/1\.1 504 /u);

        const nested = await attach(proxy, proxy.route(never));
        expect(await tunnel(nested.socket, "localhost:3000")).toMatch(/^HTTP\/1\.1 504 /u);
    });

    it("closes the upstream request when the client abandons it", async () => {
        let closed: () => void = () => undefined;
        const upstreamClosed = new Promise<void>((resolve) => (closed = resolve));
        const target = createServer((incoming, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("data: first\n\n");
            incoming.once("close", () => closed());
        });
        const port = await listening(target);
        const proxy = proxyWith();
        const { socket } = await attach(proxy, proxy.route(to(port)));
        socket.write(
            `GET http://localhost:${String(port)}/events HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        );
        let text = "";
        await new Promise<void>((resolve) =>
            socket.on("data", (chunk: Buffer) => {
                text += chunk.toString();
                if (text.includes("data: first")) resolve();
            }),
        );
        socket.destroy();
        await upstreamClosed;
    });

    it("half-closes each direction of a nested CONNECT independently", async () => {
        const received: string[] = [];
        const target = createTcpServer({ allowHalfOpen: true }, (socket) => {
            let text = "";
            socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
            socket.once("end", () => {
                received.push(text);
                // Answer only after the client has finished sending, as an upload's reply would.
                setTimeout(() => socket.end(`late reply to ${text}`), 300);
            });
        });
        const port = await listening(target);
        const proxy = proxyWith();
        const { socket } = await attach(proxy, proxy.route(to(port)));
        expect(await tunnel(socket, `localhost:${String(port)}`)).toBe(
            "HTTP/1.1 200 Connection Established\r\n\r\n",
        );
        const reply = readAll(socket);
        socket.end("hello");
        expect(await reply).toBe("late reply to hello");
        expect(received).toEqual(["hello"]);

        // The other way: the destination finishes first and still receives what follows.
        const later: string[] = [];
        const early = createTcpServer({ allowHalfOpen: true }, (peer) => {
            let text = "";
            peer.on("data", (chunk: Buffer) => (text += chunk.toString()));
            peer.once("end", () => later.push(text));
            peer.end("bye first");
        });
        const earlyPort = await listening(early);
        const second = await attach(proxy, proxy.route(to(earlyPort)));
        await tunnel(second.socket, `localhost:${String(earlyPort)}`);
        let text = "";
        second.socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
        await once(second.socket, "end");
        expect(text).toBe("bye first");
        second.socket.end("still sending");
        await expect.poll(() => later).toEqual(["still sending"]);
    });

    it("closes the other side when either side of a tunnel is reset", async () => {
        const peers: Socket[] = [];
        const target = createTcpServer({ allowHalfOpen: true }, (socket) => peers.push(socket));
        const port = await listening(target);
        const proxy = proxyWith();

        const first = await attach(proxy, proxy.route(to(port)));
        await tunnel(first.socket, `localhost:${String(port)}`);
        await expect.poll(() => peers.length).toBe(1);
        first.socket.on("error", () => undefined);
        const clientClosed = closed(first.socket);
        peers[0]!.resetAndDestroy();
        await clientClosed;

        const second = await attach(proxy, proxy.route(to(port)));
        await tunnel(second.socket, `localhost:${String(port)}`);
        await expect.poll(() => peers.length).toBe(2);
        peers[1]!.on("error", () => undefined);
        const targetClosed = closed(peers[1]!);
        second.socket.resetAndDestroy();
        await targetClosed;
    });

    it("names IPv6 literals without brackets when opening the connection", async () => {
        const target = createServer((_incoming, response) => response.end("v6"));
        const port = await listening(target);
        const proxy = proxyWith();
        const hosts: string[] = [];
        const recording: WorkspaceProxyConnector = async (host, targetPort) => {
            hosts.push(`${host} ${String(targetPort)}`);
            return await to(port)(host, targetPort);
        };
        const plain = await attach(proxy, proxy.route(recording));
        const plainReply = readAll(plain.socket);
        plain.socket.write(
            "GET http://[::1]:3000/ HTTP/1.1\r\nHost: [::1]:3000\r\nConnection: close\r\n\r\n",
        );
        expect(await plainReply).toContain("v6");

        const nested = await attach(proxy, proxy.route(recording));
        expect(await tunnel(nested.socket, "[::1]:3001")).toMatch(/^HTTP\/1\.1 200 /u);
        expect(hosts).toEqual(["::1 3000", "::1 3001"]);
    });
});
