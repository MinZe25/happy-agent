import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, IncomingMessage } from "node:http";
import { connect, createServer as createTcpServer, Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { bindAgentHttpServer } from "../../sources/socket/AgentSocket.ts";
import { WorkspaceProxy } from "../../../happy-agent-modules/sources/api/WorkspaceProxy.ts";
import { RemoteProxyConnection } from "../../../happy-agent-modules/sources/connections/impl/RemoteProxyConnection.ts";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listening(server) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    });
    return server.address().port;
}

/**
 * The native Bun front door over a workspace whose network is a connector to `networkPort`.
 * `prepare` may override admission, as a daemon that found no network would.
 */
async function frontDoor(networkPort, prepare) {
    const proxy = new WorkspaceProxy();
    cleanups.push(() => proxy.close());
    const opened = [];
    const prepared = {
        context: () => ({}),
        api: {
            listenWorkspaceProxyTcp: () => proxy.listenTcp(),
            handleRequest: async (_ctx, _req, res) => res.end("healthy"),
            handleRemoteAttachment: async () => false,
            prepareWorkspaceProxySocket: async (_ctx, pathname) => {
                if (pathname !== "/v0/workspaces/w/agents/a/proxy") return { handled: false };
                if (prepare !== undefined) return prepare();
                const route = proxy.route(async (host, port) => {
                    opened.push(`${host}:${port}`);
                    const socket = connect({
                        host: "127.0.0.1",
                        port: networkPort,
                        allowHalfOpen: true,
                    });
                    await once(socket, "connect");
                    return socket;
                });
                return { handled: true, route };
            },
            // A tunnel that reaches the HTTP server is admitted the way the daemon admits it.
            handleConnect: async (ctx, request, socket, head) => {
                const admitted = await prepared.api.prepareWorkspaceProxySocket(ctx, request.url);
                if (!admitted.handled || admitted.route === undefined) return false;
                proxy.accept(socket, head, admitted.route);
                return true;
            },
        },
    };
    const listener = await bindAgentHttpServer(prepared, "127.0.0.1", 0);
    cleanups.push(() => listener.close());
    return {
        opened,
        port: listener.port,
        async attach() {
            const socket = connect({ host: "127.0.0.1", port: listener.port, allowHalfOpen: true });
            cleanups.push(() => socket.destroy());
            await once(socket, "connect");
            const established = once(socket, "data");
            socket.write(
                "CONNECT /v0/workspaces/w/agents/a/proxy HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer fixture\r\n\r\n",
            );
            expect((await established)[0].toString()).toBe(
                "HTTP/1.1 200 Connection Established\r\n\r\n",
            );
            return socket;
        },
    };
}

async function readAll(socket) {
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString()));
    await new Promise((resolve) => {
        socket.once("end", resolve);
        socket.once("close", resolve);
    });
    return text;
}

/** A loopback socket pair: whatever is written to `inner` is read from `outer`, and back. */
async function socketPair() {
    const server = createTcpServer({ allowHalfOpen: true });
    const port = await listening(server);
    const accepted = once(server, "connection");
    const outer = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    cleanups.push(() => outer.destroy());
    const [inner] = await accepted;
    cleanups.push(() => inner.destroy());
    return { outer, inner };
}

/** Open a nested CONNECT and return its answer, leaving any bytes after it to be read. */
async function tunnel(socket, authority) {
    const answered = once(socket, "data");
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const [bytes] = await answered;
    const end = bytes.indexOf("\r\n\r\n") + 4;
    if (end >= 4 && end < bytes.byteLength) socket.unshift(bytes.subarray(end));
    return bytes.subarray(0, end >= 4 ? end : bytes.byteLength).toString();
}

test("every tunnel and request opens from the attachment's network, never natively", async () => {
    const reached = [];
    const sentinel = createTcpServer((socket) => {
        reached.push(socket.remotePort);
        socket.destroy();
    });
    const sentinelPort = await listening(sentinel);
    const app = createTcpServer({ allowHalfOpen: true }, (socket) => socket.end("network"));
    const f = await frontDoor(await listening(app));

    // A nested CONNECT naming this machine's own sentinel still opens through the route.
    const socket = await f.attach();
    expect(await tunnel(socket, `127.0.0.1:${sentinelPort}`)).toBe(
        "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    expect(await readAll(socket)).toBe("network");
    expect(f.opened).toEqual([`127.0.0.1:${sentinelPort}`]);
    expect(reached).toEqual([]);
}, 5000);

test("a desktop's tunnel to a remote opens after the remote connection served a request", async () => {
    const app = createTcpServer({ allowHalfOpen: true }, (socket) => socket.end("network"));
    const f = await frontDoor(await listening(app));
    let carriers = 0;
    const remote = new RemoteProxyConnection(() => {
        carriers += 1;
        return connect({ host: "127.0.0.1", port: f.port });
    });
    cleanups.push(() => remote.close());
    const authorize = async () => "fixture";
    // The desktop's daemon forwards ordinary requests to the remote over one pooled connection.
    const gateway = createServer((req, res) => void remote.forward(req, res, req.url, authorize));
    const warmed = await fetch(`http://127.0.0.1:${await listening(gateway)}/v0/health`);
    expect(await warmed.text()).toBe("healthy");
    expect(carriers).toBe(1);

    // The browser's tunnel, handed over as the desktop's Bun front door adapts an attachment. The
    // remote routes a connection by its first request, so the tunnel needs a connection of its own.
    const route = "/v0/workspaces/w/agents/a/proxy";
    const request = new IncomingMessage(new Socket());
    request.method = "CONNECT";
    request.url = route;
    request.headers = { host: "happy-agent.invalid", authorization: "Bearer fixture" };
    request.complete = true;
    cleanups.push(() => request.destroy());
    const { outer, inner } = await socketPair();
    const established = once(outer, "data");
    const forwarded = remote.forward(request, inner, route, authorize, Buffer.alloc(0));
    expect((await established)[0].toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(carriers).toBe(2);
    expect(await tunnel(outer, "localhost:3000")).toBe(
        "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    expect(await readAll(outer)).toBe("network");
    await forwarded;
    expect(f.opened).toEqual(["localhost:3000"]);
}, 5000);

test("an attachment admitted without a route is refused instead of connected natively", async () => {
    const reached = [];
    const sentinel = createTcpServer((socket) => {
        reached.push(socket.remotePort);
        socket.destroy();
    });
    const sentinelPort = await listening(sentinel);
    const f = await frontDoor(0, () => ({ handled: true }));
    const socket = await f.attach();
    const reply = readAll(socket);
    socket.write(`CONNECT 127.0.0.1:${sentinelPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(await reply).toStartWith("HTTP/1.1 502 ");
    expect(reached).toEqual([]);
}, 5000);

test("the destination sees the client's own headers and none of the proxy's", async () => {
    const seen = [];
    const app = createServer((req, res) => {
        seen.push(req.headers);
        res.end("ok");
    });
    const f = await frontDoor(await listening(app));
    const socket = await f.attach();
    const reply = readAll(socket);
    socket.write(
        [
            "GET http://localhost:3000/page HTTP/1.1",
            "Host: localhost:3000",
            "Authorization: Bearer site-token",
            "Cookie: session=abc",
            "Proxy-Authorization: Basic secret",
            "X-Happy-Proxy-Route: forged",
            "Connection: close",
            "",
            "",
        ].join("\r\n"),
    );
    expect(await reply).toContain("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
        host: "localhost:3000",
        authorization: "Bearer site-token",
        cookie: "session=abc",
    });
    for (const name of ["proxy-authorization", "x-happy-proxy-route", "via", "forwarded"])
        expect(seen[0][name]).toBeUndefined();
}, 5000);

test("server-sent events and a slow upload keep flowing past 30 seconds", async () => {
    let uploaded = 0;
    const app = createServer((req, res) => {
        if (req.url === "/events") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            let sent = 0;
            const timer = setInterval(() => {
                res.write(`data: ${sent}\n\n`);
                sent += 1;
                if (sent === 34) {
                    clearInterval(timer);
                    res.end();
                }
            }, 1000);
            req.once("close", () => clearInterval(timer));
            return;
        }
        req.on("data", (chunk) => (uploaded += chunk.byteLength));
        req.once("end", () => res.end(`received ${uploaded}`));
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
        await sleep(1000);
    }
    upload.write("0\r\n\r\n");

    expect(await answered).toContain(`received ${33 * 1024}`);
    const text = await streamed;
    expect(Date.now() - started).toBeGreaterThan(32_000);
    expect(text).toContain("data: 0\n\n");
    expect(text).toContain("data: 33\n\n");
}, 60_000);

test("a reply sent after the client half-closes its tunnel still arrives", async () => {
    const app = createTcpServer({ allowHalfOpen: true }, (socket) => {
        let text = "";
        socket.on("data", (chunk) => (text += chunk.toString()));
        socket.once("end", () => setTimeout(() => socket.end(`late reply to ${text}`), 500));
    });
    const f = await frontDoor(await listening(app));
    const socket = await f.attach();
    expect(await tunnel(socket, "localhost:3000")).toBe(
        "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    const reply = readAll(socket);
    socket.end("upload");
    expect(await reply).toBe("late reply to upload");
}, 10_000);

test("the destination's request closes when the client goes away", async () => {
    let closed;
    const destinationClosed = new Promise((resolve) => (closed = resolve));
    const app = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        req.once("close", () => closed());
    });
    const f = await frontDoor(await listening(app));
    const socket = await f.attach();
    const first = new Promise((resolve) => {
        let text = "";
        socket.on("data", (chunk) => {
            text += chunk.toString();
            if (text.includes("data: first")) resolve();
        });
    });
    socket.write("GET http://localhost:3000/events HTTP/1.1\r\nHost: localhost:3000\r\n\r\n");
    await first;
    socket.destroy();
    await destinationClosed;
}, 10_000);

test("a fast download waits for a slow reader instead of filling memory", async () => {
    const total = 96 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let written = 0;
    let finished;
    const done = new Promise((resolve) => (finished = resolve));
    const app = createTcpServer((socket) => {
        const pump = () => {
            while (written < total) {
                written += chunk.byteLength;
                if (!socket.write(chunk)) {
                    socket.once("drain", pump);
                    return;
                }
            }
            socket.end();
            finished();
        };
        pump();
    });
    const f = await frontDoor(await listening(app));
    const socket = await f.attach();
    expect(await tunnel(socket, "localhost:3000")).toBe(
        "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    socket.pause();
    await sleep(1500);
    // Without backpressure the whole download would already be written, or the bridge closed.
    expect(written).toBeLessThan(total / 2);
    let received = 0;
    socket.on("data", (data) => (received += data.byteLength));
    socket.resume();
    await once(socket, "end");
    await done;
    expect(received).toBe(total);
}, 30_000);
