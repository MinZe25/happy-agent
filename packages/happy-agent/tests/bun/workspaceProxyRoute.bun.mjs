import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { bindAgentHttpServer } from "../../sources/socket/AgentSocket.ts";
import { WorkspaceProxy } from "../../../happy-agent-modules/sources/api/WorkspaceProxy.ts";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A runner folder's attachment through the native Bun front door. The "runner" network is a
 * connector that knows where its own `localhost:3000` is; this machine has nothing there.
 */
async function runnerFixture() {
    const proxy = new WorkspaceProxy();
    cleanups.push(() => proxy.close());
    const seen = [];
    const app = createServer((req, res) => {
        seen.push({ url: req.url, route: req.headers["x-happy-proxy-route"] });
        res.end(`runner served ${req.url}`);
    });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        app.closeAllConnections();
        await new Promise((resolve) => app.close(resolve));
    });
    const opened = [];
    const prepared = {
        context: () => ({}),
        api: {
            listenWorkspaceProxyTcp: () => proxy.listenTcp(),
            handleRequest: async (_ctx, _req, res) => res.end("healthy"),
            handleRemoteAttachment: async () => false,
            prepareWorkspaceProxySocket: async (_ctx, pathname) => {
                if (pathname === "/v0/workspaces/runnerspace/services/retired/proxy") {
                    return {
                        handled: true,
                        rejection: {
                            status: 501,
                            code: "unsupported",
                            message: "Workspace services are unavailable in this daemon.",
                        },
                    };
                }
                if (pathname !== "/v0/workspaces/runnerspace/proxy") return { handled: false };
                const route = proxy.route(async (host, port) => {
                    opened.push(`${host}:${port}`);
                    const socket = connect(app.address().port, "127.0.0.1");
                    await once(socket, "connect");
                    return socket;
                });
                return { handled: true, route };
            },
        },
    };
    const listener = await bindAgentHttpServer(prepared, "127.0.0.1", 0);
    cleanups.push(() => listener.close());
    return {
        opened,
        seen,
        async attach(pathname = "/v0/workspaces/runnerspace/proxy", status = 200) {
            const socket = connect(listener.port, "127.0.0.1");
            cleanups.push(() => socket.destroy());
            const established = once(socket, "data");
            socket.write(
                `CONNECT ${pathname} HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer fixture\r\n\r\n`,
            );
            const response = (await established)[0].toString();
            if (status === 200)
                expect(response).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
            else expect(response).toStartWith(`HTTP/1.1 ${status} `);
            return socket;
        },
    };
}

async function readUntilEnd(socket) {
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString()));
    await once(socket, "end");
    return text;
}

test("a retired service CONNECT receives workspace admission's unavailable response", async () => {
    const f = await runnerFixture();
    const socket = await f.attach("/v0/workspaces/runnerspace/services/retired/proxy", 501);
    socket.destroy();
    expect(f.opened).toEqual([]);
    expect(f.seen).toEqual([]);
}, 5000);

test("a runner folder's plain proxy request reaches the runner's own localhost", async () => {
    const f = await runnerFixture();
    const socket = await f.attach();
    const reply = readUntilEnd(socket);
    socket.write(
        "GET http://localhost:3000/preview HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n",
    );
    expect(await reply).toContain("runner served /preview");
    expect(f.opened).toEqual(["localhost:3000"]);
    expect(f.seen).toEqual([{ url: "/preview", route: undefined }]);
}, 5000);

test("a runner folder's nested CONNECT tunnels from the runner", async () => {
    const f = await runnerFixture();
    const socket = await f.attach();
    let text = "";
    let asked = false;
    socket.on("data", (chunk) => {
        text += chunk.toString();
        if (!asked && text.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")) {
            asked = true;
            socket.write(
                "GET /inside HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n",
            );
        }
    });
    socket.write("CONNECT localhost:3000 HTTP/1.1\r\nHost: localhost:3000\r\n\r\n");
    await once(socket, "end");
    expect(text).toContain("runner served /inside");
    expect(f.opened).toEqual(["localhost:3000"]);
}, 5000);
