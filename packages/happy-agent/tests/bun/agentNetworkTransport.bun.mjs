import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";

import { createAgentGym } from "../../../happy-agent-gym/sources/index.ts";

/**
 * Agent networks through the real daemon on Bun's native team front door: the browser reads an
 * agent's network over HTTP, then opens that network's tunnel on a connection of its own.
 */
let gym;
let site;
let workspaceId;

function teamConfig() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const encoded = [
        { alg: "EdDSA", typ: "JWT" },
        {
            sub: "alice",
            iss: "https://networks.test",
            aud: "network-tests",
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
    ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .join(".");
    return {
        config: `
[feature.team]
enabled = true
host = "127.0.0.1"
port = 0
authentication = "jwt"
owner_user_id = "alice"
[feature.team.jwt]
name = "Network test sign-in"
authorization_url = "https://networks.test/authorize"
token_url = "https://networks.test/token"
client_id = "network-tests"
issuer = "https://networks.test"
audience = "network-tests"
algorithms = ["EdDSA"]
public_key = """
${pem}"""
`,
        token: `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`,
    };
}

beforeAll(async () => {
    const team = teamConfig();
    gym = await createAgentGym({
        config: team.config,
        timeoutMs: 20_000,
        teamUser: { token: team.token, name: "Alice" },
    });
    workspaceId = (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId;
    site = createServer((request, response) =>
        response.end(`site saw ${request.url} with ${request.headers.cookie}`),
    );
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
    site?.closeAllConnections();
    await new Promise((resolve) => (site === undefined ? resolve() : site.close(resolve)));
    await gym?.dispose();
});

/** Send a `CONNECT` as a fresh connection's first request; resolve with its answer and socket. */
async function attach(path, authorization = `Bearer ${gym.token}`) {
    // The client's URLs carry the team listener's address.
    const endpoint = new URL(gym.client.networkProxyUrl("host"));
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    await once(socket, "connect");
    const answered = once(socket, "data");
    socket.write(
        `CONNECT ${path} HTTP/1.1\r\nHost: ${endpoint.host}\r\nAuthorization: ${authorization}\r\n\r\n`,
    );
    const [bytes] = await answered;
    return { socket, answer: bytes.toString("latin1") };
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

test("an agent's network is read over HTTP and its tunnel reaches the network it names", async () => {
    const { networkId } = await gym.client.getWorkspaceAgentNetwork(
        workspaceId,
        gym.defaultSessionId,
    );
    expect(networkId).toBe("host");
    const path = new URL(gym.client.networkProxyUrl(networkId)).pathname;
    const { socket, answer } = await attach(path);
    expect(answer).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    const reply = readAll(socket);
    const port = site.address().port;
    socket.write(
        `GET http://127.0.0.1:${port}/page HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: session=abc\r\nConnection: close\r\n\r\n`,
    );
    expect(await reply).toContain("site saw /page with session=abc");
}, 20_000);

test("a network tunnel is refused without the team's credential or for a network not served", async () => {
    const refused = await attach("/v0/networks/host/proxy", "Bearer not-a-team-token");
    refused.socket.destroy();
    expect(refused.answer).toStartWith("HTTP/1.1 401 ");
    for (const networkId of ["Host", "r-nowhere", "c-0123456789abcdef0123456789abcdef"]) {
        const missing = await attach(`/v0/networks/${networkId}/proxy`);
        missing.socket.destroy();
        expect(missing.answer).toStartWith("HTTP/1.1 404 ");
    }
}, 20_000);
