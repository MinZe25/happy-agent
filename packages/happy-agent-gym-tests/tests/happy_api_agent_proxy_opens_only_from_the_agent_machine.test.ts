import { request } from "node:http";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("agent-scoped workspace proxy", () => {
    it("admits only the workspace's own agent and never falls back to this machine", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ type: "text", text: "Ready." }] }],
        });
        gyms.add(gym);
        const agentId = gym.defaultSessionId;
        const { workspaceId } = (await gym.client.getAgent(agentId)).agent;
        const agentProxy = new URL(gym.client.workspaceAgentProxyUrl(workspaceId, agentId))
            .pathname;
        expect(agentProxy).toBe(`/v0/workspaces/${workspaceId}/agents/${agentId}/proxy`);

        // The gym's agent works on a scripted machine that has no network of its own. The tunnel
        // is refused rather than opened from the daemon's machine instead.
        expect(await connectStatus(gym, agentProxy, gym.token)).toEqual({
            status: 501,
            code: "unsupported",
        });
        expect(await connectStatus(gym, agentProxy, "wrong-token")).toMatchObject({
            status: 401,
        });
        expect(
            await connectStatus(
                gym,
                `/v0/workspaces/${workspaceId}/agents/missingagent/proxy`,
                gym.token,
            ),
        ).toMatchObject({ status: 404, code: "not_found" });

        // An agent is reachable only beneath its own workspace.
        const child = await gym.client.createWorkspace({
            name: "elsewhere",
            parentId: workspaceId,
        });
        const childId = await gym.waitUntil(async () => {
            const current = (await gym.client.getWorkspace(child.workspace.id)).workspace;
            return current.initialization.status === "ready" ? current.id : undefined;
        }, "child workspace readiness");
        expect(
            await connectStatus(
                gym,
                `/v0/workspaces/${childId}/agents/${agentId}/proxy`,
                gym.token,
            ),
        ).toMatchObject({ status: 404, code: "not_found" });

        // The folder's own proxy keeps reaching this machine for a host workspace.
        expect(
            await connectStatus(gym, `/v0/workspaces/${workspaceId}/proxy`, gym.token),
        ).toMatchObject({ status: 200 });

        await gym.client.archiveAgent(agentId);
        expect(await connectStatus(gym, agentProxy, gym.token)).toMatchObject({
            status: 409,
            code: "conflict",
        });
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("refuses the folder proxy of a workspace whose agents each work in a container", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ type: "text", text: "Ready." }] }],
        });
        gyms.add(gym);
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

        expect(
            await connectStatus(gym, `/v0/workspaces/${docker.id}/proxy`, gym.token),
        ).toMatchObject({ status: 501, code: "unsupported" });
        expect(gym.inference.unscripted).toEqual([]);
    });
});

/** The status and error code a `CONNECT` is answered with, closing any tunnel it opened. */
function connectStatus(
    gym: AgentGym,
    path: string,
    token: string,
): Promise<{ status: number | undefined; code?: string }> {
    return new Promise((resolve, reject) => {
        const call = request({
            socketPath: gym.socketPath,
            method: "CONNECT",
            path,
            headers: { authorization: `Bearer ${token}` },
        });
        call.once("error", reject);
        call.once("connect", (response, socket, head) => {
            socket.destroy();
            if (response.statusCode === 200) {
                resolve({ status: 200 });
                return;
            }
            let body = head.toString();
            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.once("end", () => resolve({ status: response.statusCode, ...parse(body) }));
            response.once("error", () => resolve({ status: response.statusCode, ...parse(body) }));
        });
        call.setTimeout(10_000, () => call.destroy(new Error("The proxy did not answer.")));
        call.end();
    });
}

function parse(body: string): { code?: string } {
    try {
        const parsed = JSON.parse(body) as { code?: unknown };
        return typeof parsed.code === "string" ? { code: parsed.code } : {};
    } catch {
        return {};
    }
}
