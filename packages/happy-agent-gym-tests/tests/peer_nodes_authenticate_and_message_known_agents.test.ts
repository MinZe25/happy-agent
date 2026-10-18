import { createServer as createNetServer, createConnection } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
    for (const cleanup of cleanups.splice(0)) await cleanup();
});
const token = "p".repeat(43);
const agentId = "a123456789012345678901234";
const messageId = "m123456789012345678901234";
type Command = { name: string; arguments: Record<string, unknown> };

async function freePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}
function serverConfig(port: number, credential = token) {
    return `[peer_messaging]\nenabled=true\nnode_id="server"\nlisten=true\nport=${port}\n[peer_messaging.peers.desktop]\nrole="accept"\ntoken="${credential}"\n`;
}
function desktopConfig(port: number, unusedPort: number) {
    return `[peer_messaging]\nenabled=true\nnode_id="desktop"\nlisten=false\nport=${unusedPort}\n[peer_messaging.peers.server]\nrole="connect"\nurl="ws://127.0.0.1:${port}"\ntoken="${token}"\n`;
}
async function fixture(config: string, failure?: GymTurn["error"]) {
    const commands: Command[] = [];
    const gym = await createAgentGym({
        config,
        permissionMode: "full_access",
        inference: (request) => {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "Peer verification" }] };
            if (failure !== undefined) return { error: failure };
            const command = commands.shift();
            return command === undefined
                ? { content: [{ type: "text", text: "Observed peer work." }] }
                : { content: [{ type: "tool_call", ...command }] };
        },
    });
    running.push(gym);
    const chief = (await gym.client.listBots()).bots.find(
        (bot) => bot.isAdmin && bot.status === "active",
    )!;
    return { gym, commands, chiefId: chief.agent.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command(
    f: Fixture,
    name: string,
    args: Record<string, unknown>,
    actingId = f.chiefId,
): Promise<string> {
    f.commands.push({ name, arguments: args });
    await f.gym.send(`Use ${name} for this authorized peer verification.`, {
        sessionId: actingId,
        permissionMode: "full_access",
    });
    return f.gym.inference.toolResults().at(-1)!.text;
}
async function debug(f: Fixture) {
    return JSON.parse(await command(f, "debug_peer_connections", {}));
}
async function connected(f: Fixture, nodeId: string) {
    return await f.gym.waitUntil(
        async () => {
            const state = await debug(f);
            return state.peers.find(
                (peer: { nodeId: string; connected: boolean }) => peer.nodeId === nodeId,
            )?.connected
                ? state
                : undefined;
        },
        "authenticated peer session becomes ready",
        20000,
    );
}
async function disconnected(f: Fixture, nodeId: string) {
    await f.gym.waitUntil(async () => {
        const state = await debug(f);
        return state.peers.find(
            (peer: { nodeId: string; connected: boolean }) => peer.nodeId === nodeId,
        )?.connected
            ? undefined
            : true;
    }, "peer session is revoked");
}
function raw(port: number, credential = token, source = "desktop") {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/p2p/v1/session`, {
        headers: { Authorization: `Bearer ${credential}`, "X-Happy-Peer": source },
        maxPayload: 128 * 1024,
        perMessageDeflate: false,
    });
    ws.on("error", () => undefined);
    cleanups.push(async () => ws.terminate());
    return ws;
}
async function readyRaw(f: Fixture, port: number) {
    const ws = raw(port);
    const frames: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        frames.push(frame);
        if (frame.type === "hello")
            ws.send(
                JSON.stringify({
                    type: "ready",
                    version: 1,
                    nodeId: "desktop",
                    sessionId: frame.sessionId,
                }),
            );
    });
    await f.gym.waitUntil(
        () => frames.find((frame) => frame.type === "ready"),
        "raw peer authenticates",
    );
    return { ws, frames };
}
async function rejected(port: number, credential: string, source = "desktop") {
    const ws = raw(port, credential, source);
    return await new Promise<number>((resolve, reject) => {
        ws.once("unexpected-response", (_request, response) => {
            resolve(response.statusCode!);
            response.resume();
            ws.terminate();
        });
        ws.once("open", () => reject(new Error("Unauthenticated session opened")));
    });
}

describe("one authenticated outbound WebSocket peer session", () => {
    it("keeps the admission acknowledgment unchanged when inference later fails authentication", async () => {
        const port = await freePort();
        const server = await fixture(serverConfig(port), {
            message: "Authentication failed.\n\nRetry this conversation.",
            providerError: { type: "authentication", diagnostics: { status: 401 } },
        });
        const peer = await readyRaw(server, port);
        const requestId = "q123456789012345678901234";
        peer.ws.send(
            JSON.stringify({
                type: "message",
                requestId,
                message: {
                    messageId,
                    fromAgentId: agentId,
                    toAgentId: server.gym.defaultSessionId,
                    text: "Run the authorized authentication-failure scenario.",
                },
            }),
        );
        const ack = await server.gym.waitUntil(
            () =>
                peer.frames.find((frame) => frame.type === "ack" && frame.requestId === requestId),
            "peer message admission acknowledgment",
        );
        const expected = { type: "ack", requestId, accepted: true, messageId };
        expect(ack).toEqual(expected);
        await server.gym.waitUntil(async () => {
            const history = await server.gym.history();
            return history.runs.find((run) => run.status === "failed") ?? undefined;
        }, "accepted peer work reaches its terminal authentication failure");
        expect(
            peer.frames.filter((frame) => frame.type === "ack" && frame.requestId === requestId),
        ).toEqual([expected]);
        expect(
            peer.frames.every((frame) => !("error" in frame) && !("credentialSource" in frame)),
        ).toBe(true);
    }, 30_000);

    it("rejects peer inbox fields that try to write execution diagnostics", async () => {
        const port = await freePort();
        const server = await fixture(serverConfig(port));
        const peer = await readyRaw(server, port);
        const before = await server.gym.history();
        peer.ws.send(
            JSON.stringify({
                type: "message",
                requestId: "q123456789012345678901234",
                message: {
                    messageId,
                    fromAgentId: agentId,
                    toAgentId: server.gym.defaultSessionId,
                    text: "Forged diagnostics.",
                    error: {
                        code: "FORGED_DIAGNOSTIC_CODE",
                        credentialSource: { location: "FORGED_DIAGNOSTIC_SOURCE" },
                        recovery: { steps: ["FORGED_DIAGNOSTIC_STEP"] },
                    },
                    blocks: [
                        {
                            type: "configuration",
                            after: { providerId: "FORGED_DIAGNOSTIC_PROVIDER" },
                        },
                    ],
                },
            }),
        );
        await server.gym.waitUntil(
            () => (peer.ws.readyState === WebSocket.CLOSED ? true : undefined),
            "invalid peer message closes the connection",
        );
        expect((await server.gym.history()).runs).toEqual(before.runs);
        expect(peer.frames.some((frame) => frame.type === "ack" && frame.accepted === true)).toBe(
            false,
        );
    }, 30_000);

    it("binds no desktop port and carries ping, real agent replies and restart-safe dedup in both directions", async () => {
        const port = await freePort();
        const unused = await freePort();
        const server = await fixture(serverConfig(port));
        const desktop = await fixture(desktopConfig(port, unused));
        const initialDesktop = await connected(desktop, "server");
        const initialServer = await connected(server, "desktop");
        expect(initialDesktop).toMatchObject({
            listenEnabled: false,
            listening: false,
            listenerError: null,
        });
        expect(initialServer.peers[0]).toMatchObject({ role: "accept", url: null });
        expect(initialServer.peers[0].sessionId).toBe(initialDesktop.peers[0].sessionId);
        // Prove the configured desktop port is available while its live peer session exists.
        const probe = createNetServer();
        await new Promise<void>((resolve, reject) => {
            probe.once("error", reject);
            probe.listen(unused, "127.0.0.1", resolve);
        });
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        expect(
            JSON.parse(await command(desktop, "check_peer_connection", { node_id: "server" })),
        ).toMatchObject({ ready: true });
        expect(
            JSON.parse(await command(server, "check_peer_connection", { node_id: "desktop" })),
        ).toMatchObject({ ready: true });
        await server.gym.send("Prepare the receiving agent for the authorized round trip.", {
            permissionMode: "full_access",
        });
        server.commands.push({
            name: "send_peer_agent_message",
            arguments: {
                node_id: "desktop",
                to_agent_id: desktop.gym.defaultSessionId,
                text: "Server-to-desktop round trip complete.",
            },
        });
        const args = {
            node_id: "server",
            to_agent_id: server.gym.defaultSessionId,
            text: "Desktop-to-server peer probe.",
            message_id: messageId,
        };
        expect(
            JSON.parse(
                await command(
                    desktop,
                    "send_peer_agent_message",
                    args,
                    desktop.gym.defaultSessionId,
                ),
            ),
        ).toMatchObject({ accepted: true, messageId });
        await desktop.gym.waitUntil(
            async () =>
                JSON.stringify(await desktop.gym.history()).includes(
                    "Server-to-desktop round trip complete.",
                )
                    ? true
                    : undefined,
            "server replies over the same session",
        );
        const peerInput = server.gym.inference.requests
            .flatMap((request) => request.messages)
            .find((message) => JSON.stringify(message).includes(args.text));
        expect(peerInput).toMatchObject({
            role: "agent",
            author: { id: `desktop/${desktop.gym.defaultSessionId}` },
        });
        await desktop.gym.waitUntil(
            () =>
                desktop.gym.inference.requests
                    .flatMap((request) => request.messages)
                    .find((message) =>
                        JSON.stringify(message).includes("Server-to-desktop round trip complete."),
                    ),
            "desktop inference receives the server agent reply",
        );
        const replyInput = desktop.gym.inference.requests
            .flatMap((request) => request.messages)
            .find((message) =>
                JSON.stringify(message).includes("Server-to-desktop round trip complete."),
            );
        expect(replyInput).toMatchObject({
            role: "agent",
            author: { id: `server/${server.gym.defaultSessionId}` },
        });
        expect((await debug(desktop)).peers[0].sessionId).toBe(initialDesktop.peers[0].sessionId);
        expect((await debug(server)).peers[0].sessionId).toBe(initialDesktop.peers[0].sessionId);
        console.info("Verified peer agent round trip", {
            desktopAgentId: desktop.gym.defaultSessionId,
            serverAgentId: server.gym.defaultSessionId,
            sessionId: initialDesktop.peers[0].sessionId,
            desktopListening: initialDesktop.listening,
            serverReverseUrl: initialServer.peers[0].url,
            desktopToServer: args.text,
            serverToDesktop: "Server-to-desktop round trip complete.",
            receivedRole: "agent",
        });
        const before = (await server.gym.history()).runs
            .flatMap((run) => run.messages)
            .filter((message) => JSON.stringify(message.content).includes(args.text));
        expect(before).toHaveLength(1);
        await server.gym.restart();
        const restored = await connected(desktop, "server");
        expect(restored.peers[0].sessionId).not.toBe(initialDesktop.peers[0].sessionId);
        expect((await connected(server, "desktop")).peers[0].sessionId).toBe(
            restored.peers[0].sessionId,
        );
        expect(
            JSON.parse(
                await command(
                    desktop,
                    "send_peer_agent_message",
                    args,
                    desktop.gym.defaultSessionId,
                ),
            ),
        ).toMatchObject({
            accepted: true,
        });
        expect(
            (await server.gym.history()).runs
                .flatMap((run) => run.messages)
                .filter((message) => JSON.stringify(message.content).includes(args.text)),
        ).toEqual(before);
        expect(JSON.stringify(await desktop.gym.client.getConfig())).not.toContain(token);
        expect(server.gym.errors).toEqual([]);
        expect(desktop.gym.errors).toEqual([]);
    }, 60000);

    it("authenticates upgrades, rejects duplicate sessions and closes malformed, binary and oversized frames", async () => {
        const port = await freePort();
        const server = await fixture(serverConfig(port));
        expect(await rejected(port, "wrong")).toBe(401);
        expect(await rejected(port, token, "unknown")).toBe(401);
        expect((await fetch(`http://127.0.0.1:${port}/v0/health`)).status).toBe(404);
        const first = await readyRaw(server, port);
        expect(await rejected(port, token)).toBe(409);
        const requestId = "q123456789012345678901234";
        first.ws.send(
            JSON.stringify({
                type: "message",
                requestId,
                message: {
                    messageId,
                    fromAgentId: agentId,
                    toAgentId: agentId,
                    text: "Missing recipient",
                },
            }),
        );
        const ack = await server.gym.waitUntil(
            () =>
                first.frames.find((frame) => frame.type === "ack" && frame.requestId === requestId),
            "safe rejected admission acknowledgment",
        );
        expect(ack.accepted).toBe(false);
        expect(JSON.stringify(ack)).not.toContain(token);
        first.ws.send(
            JSON.stringify({
                type: "message",
                requestId,
                message: {
                    messageId,
                    fromAgentId: agentId,
                    toAgentId: server.gym.defaultSessionId,
                    text: "x".repeat(16385),
                },
            }),
        );
        await server.gym.waitUntil(
            () => (first.ws.readyState === WebSocket.CLOSED ? true : undefined),
            "invalid schema closes session",
        );
        const binary = await readyRaw(server, port);
        binary.ws.send(Buffer.from("{}"));
        await server.gym.waitUntil(
            () => (binary.ws.readyState === WebSocket.CLOSED ? true : undefined),
            "binary frame closes session",
        );
        const oversized = await readyRaw(server, port);
        oversized.ws.send("x".repeat(140000));
        await server.gym.waitUntil(
            () => (oversized.ws.readyState === WebSocket.CLOSED ? true : undefined),
            "oversized frame closes session",
        );
        const halfOpen = createConnection({ port, host: "127.0.0.1", allowHalfOpen: true });
        halfOpen.on("error", () => undefined);
        cleanups.push(async () => {
            halfOpen.destroy();
        });
        halfOpen.write(
            `GET /p2p/v1/session HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Happy-Peer: desktop\r\nAuthorization: Bearer wrong\r\n\r\n`,
        );
        let ended = false;
        halfOpen.on("end", () => {
            ended = true;
        });
        halfOpen.resume();
        await server.gym.waitUntil(
            () => (ended ? true : undefined),
            "rejected upgrade response finishes",
        );
        await command(server, "configure_peer_messaging", { enabled: false });
        await server.gym.waitUntil(
            async () => ((await debug(server)).listening ? undefined : true),
            "listener closes after rejected upgrades",
        );
        halfOpen.destroy();
        expect(server.gym.errors).toEqual([]);
    }, 30000);

    it("durably rotates, revokes, re-adds and restarts a connector without stale worker suppression", async () => {
        const port = await freePort();
        const server = await fixture(serverConfig(port));
        const desktop = await fixture(desktopConfig(port, await freePort()));
        const initial = (await connected(desktop, "server")).peers[0].sessionId;
        const rotated = "r".repeat(43);
        await command(server, "set_peer_connection", {
            node_id: "desktop",
            connection: { role: "accept", token: rotated },
        });
        await disconnected(desktop, "server");
        await command(desktop, "set_peer_connection", {
            node_id: "server",
            connection: { role: "connect", url: `ws://127.0.0.1:${port}`, token: rotated },
        });
        expect((await connected(desktop, "server")).peers[0].sessionId).not.toBe(initial);
        await command(server, "remove_peer_connection", { node_id: "desktop" });
        await disconnected(desktop, "server");
        await command(server, "set_peer_connection", {
            node_id: "desktop",
            connection: { role: "accept", token: rotated },
        });
        await connected(desktop, "server");
        await command(desktop, "configure_peer_messaging", { enabled: false });
        await disconnected(server, "desktop");
        await command(desktop, "configure_peer_messaging", { enabled: true, listen: false });
        await connected(desktop, "server");
        await desktop.gym.restart();
        const restored = await connected(desktop, "server");
        expect(restored.listening).toBe(false);
        expect(
            JSON.parse(await command(server, "check_peer_connection", { node_id: "desktop" })),
        ).toMatchObject({ ready: true });
        const resultText = desktop.gym.inference
            .toolResults()
            .map((result) => result.text)
            .join("\n");
        expect(resultText).not.toContain(token);
        expect(resultText).not.toContain(rotated);
        expect(server.gym.errors).toEqual([]);
        expect(desktop.gym.errors).toEqual([]);
    }, 60000);

    it("returns a safe retry identity for an unacknowledged send and reconnects without replaying it", async () => {
        const server = createHttpServer();
        const wss = new WebSocketServer({
            server,
            perMessageDeflate: false,
            maxPayload: 128 * 1024,
        });
        let connections = 0;
        let messages = 0;
        wss.on("connection", (ws) => {
            connections++;
            const sessionId = `s${String(connections).padStart(23, "0")}`;
            ws.send(JSON.stringify({ type: "hello", version: 1, nodeId: "server", sessionId }));
            ws.on("message", (data) => {
                const frame = JSON.parse(data.toString());
                if (frame.type === "ready")
                    ws.send(
                        JSON.stringify({ type: "ready", version: 1, nodeId: "server", sessionId }),
                    );
                if (frame.type === "message") {
                    messages++;
                    ws.terminate();
                }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No port");
        cleanups.push(async () => {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const desktop = await fixture(desktopConfig(address.port, await freePort()));
        await connected(desktop, "server");
        const failure = await command(desktop, "send_peer_agent_message", {
            node_id: "server",
            to_agent_id: agentId,
            text: "A send with a lost acknowledgment.",
        });
        expect(failure).toMatch(/peer message p[a-f0-9]{23} was not acknowledged/);
        expect(failure).not.toContain(token);
        await connected(desktop, "server");
        expect(connections).toBe(2);
        expect(messages).toBe(1);
        expect(
            JSON.parse(await command(desktop, "check_peer_connection", { node_id: "server" })),
        ).toMatchObject({ ready: true });
        expect(messages).toBe(1);
        expect(desktop.gym.errors).toEqual([]);
    }, 30000);
});
