import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import {
    createServer as createTcpServer,
    type AddressInfo,
    type Server,
    type Socket,
} from "node:net";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("agent-scoped workspace proxy", () => {
    it("opens a never-run agent's connections from its own machine and ends them on archive", async () => {
        const gym = await started();
        const agentId = gym.defaultSessionId;
        const { workspaceId } = (await gym.client.getAgent(agentId)).agent;
        const path = new URL(gym.client.workspaceAgentProxyUrl(workspaceId, agentId)).pathname;
        expect(path).toBe(`/v0/workspaces/${workspaceId}/agents/${agentId}/proxy`);
        const site = await siteFixture();

        // The agent has never run, so this first attachment builds its machine from its stored
        // configuration and the database, the way its first command would.
        const tunnel = await attach(gym, path);
        expect(tunnel.status).toBe(200);
        const reply = readAll(tunnel.socket!);
        tunnel.socket!.write(
            `GET http://127.0.0.1:${String(site.port)}/hello HTTP/1.1\r\nHost: 127.0.0.1:${String(site.port)}\r\nAuthorization: Bearer site-token\r\nConnection: close\r\n\r\n`,
        );
        expect(await reply).toContain("from the site");
        expect(site.seen[0]).toMatchObject({ authorization: "Bearer site-token" });
        expect(gym.machineConnections).toEqual([
            { cwd: gym.workspacePath, host: "127.0.0.1", port: site.port },
        ]);

        expect((await attach(gym, path, "wrong-token")).status).toBe(401);
        expect(
            await attach(gym, `/v0/workspaces/${workspaceId}/agents/missingagent/proxy`),
        ).toMatchObject({ status: 404, code: "not_found" });

        // A held tunnel ends when its agent is archived, and the agent is no longer reachable.
        const held = await heldFixture();
        const open = await attach(gym, path);
        open.socket!.write(
            `CONNECT 127.0.0.1:${String(held.port)} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
        );
        const [answer] = (await once(open.socket!, "data")) as [Buffer];
        expect(answer.toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
        open.socket!.on("error", () => undefined);
        const closed = new Promise<void>((resolve) => open.socket!.once("close", () => resolve()));
        await gym.client.archiveAgent(agentId);
        await closed;
        expect(await attach(gym, path)).toMatchObject({ status: 409, code: "conflict" });
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("reaches a bot's agent from the bot's machine, and only beneath the bot's workspace", async () => {
        const gym = await started();
        const bot = (await gym.client.createBot({ name: "Preview bot" })).bot;
        const site = await siteFixture();
        const path = `/v0/workspaces/${bot.workspaceId}/agents/${bot.agent.id}/proxy`;

        const tunnel = await attach(gym, path);
        expect(tunnel.status).toBe(200);
        const reply = readAll(tunnel.socket!);
        tunnel.socket!.write(
            `GET http://127.0.0.1:${String(site.port)}/bot HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
        );
        expect(await reply).toContain("from the site");
        expect(gym.machineConnections).toEqual([
            { cwd: bot.compute.path, host: "127.0.0.1", port: site.port },
        ]);

        const { workspaceId } = (await gym.client.getAgent(gym.defaultSessionId)).agent;
        expect(
            await attach(gym, `/v0/workspaces/${workspaceId}/agents/${bot.agent.id}/proxy`),
        ).toMatchObject({ status: 404, code: "not_found" });
        expect(
            await attach(
                gym,
                `/v0/workspaces/${bot.workspaceId}/agents/${gym.defaultSessionId}/proxy`,
            ),
        ).toMatchObject({ status: 404, code: "not_found" });
        expect(gym.errors).toEqual([]);
    });

    it("refuses the folder proxy of a workspace whose agents each work in a container", async () => {
        const gym = await started();
        const { workspaceId: projectId } = (await gym.client.getAgent(gym.defaultSessionId)).agent;
        const project = await gym.waitUntil(async () => {
            const current = (await gym.client.getProject(projectId)).project;
            return current.initialization.status === "ready" ? current : undefined;
        }, "project readiness");
        await gym.client.replaceProjectSettings(
            projectId,
            { defaultWorkspaceCompute: { type: "docker", image: "gym/agent-proxy:latest" } },
            { ifMatch: project.version },
        );
        const created = await gym.client.createWorkspace({ name: "boxed", parentId: projectId });
        const docker = await gym.waitUntil(async () => {
            const current = (await gym.client.getWorkspace(created.workspace.id)).workspace;
            if (current.initialization.status === "failed")
                throw new Error(current.initialization.error ?? "workspace failed");
            return current.initialization.status === "ready" ? current : undefined;
        }, "docker workspace readiness");
        expect(docker.compute).toMatchObject({ type: "docker", image: "gym/agent-proxy:latest" });

        expect(await attach(gym, `/v0/workspaces/${docker.id}/proxy`)).toMatchObject({
            status: 501,
            code: "unsupported",
        });
        // The folder proxy of an ordinary workspace still reaches this machine.
        expect((await attach(gym, `/v0/workspaces/${projectId}/proxy`)).status).toBe(200);
        expect(gym.machineConnections).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});

async function started(): Promise<AgentGym> {
    const gym = await createAgentGym({
        inference: [{ content: [{ type: "text", text: "Ready." }] }],
    });
    gyms.add(gym);
    return gym;
}

async function listening(server: Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
        async () =>
            await new Promise<void>((resolve) => {
                (server as { closeAllConnections?: () => void }).closeAllConnections?.();
                server.close(() => resolve());
            }),
    );
    return (server.address() as AddressInfo).port;
}

/** A site the agent's machine serves on its loopback, recording what each request carried. */
async function siteFixture(): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
    const seen: IncomingHttpHeaders[] = [];
    const port = await listening(
        createServer((incoming, response) => {
            seen.push(incoming.headers);
            response.end("from the site");
        }),
    );
    return { port, seen };
}

/** A TCP service that keeps every connection open until the test ends. */
async function heldFixture(): Promise<{ port: number }> {
    const sockets: Socket[] = [];
    const server = createTcpServer((socket) => {
        socket.on("error", () => undefined);
        sockets.push(socket);
    });
    cleanups.push(() => {
        for (const socket of sockets) socket.destroy();
    });
    return { port: await listening(server) };
}

/** Attach to a proxy route, returning the open tunnel or the status and code it was refused with. */
function attach(
    gym: AgentGym,
    path: string,
    token = gym.token,
): Promise<{ status: number | undefined; code?: string; socket?: Socket }> {
    return new Promise((resolve, reject) => {
        const call = request({
            socketPath: gym.socketPath,
            method: "CONNECT",
            path,
            headers: { authorization: `Bearer ${token}` },
        });
        call.once("error", reject);
        call.once("connect", (response, socket, head) => {
            if (response.statusCode === 200) {
                cleanups.push(() => void socket.destroy());
                if (head.byteLength > 0) socket.unshift(head);
                resolve({ status: 200, socket });
                return;
            }
            let body = head.toString();
            socket.on("data", (chunk: Buffer) => (body += chunk.toString()));
            const done = () => {
                socket.destroy();
                resolve({ status: response.statusCode, ...parse(body) });
            };
            socket.once("end", done);
            socket.once("close", done);
        });
        call.setTimeout(10_000, () => call.destroy(new Error("The proxy did not answer.")));
        call.end();
    });
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

function parse(body: string): { code?: string } {
    try {
        const parsed = JSON.parse(body.slice(body.indexOf("{"))) as { code?: unknown };
        return typeof parsed.code === "string" ? { code: parsed.code } : {};
    } catch {
        return {};
    }
}
