import { request } from "node:http";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("retired workspace services", () => {
    it("omits service tools and reports the optional API as unavailable after workspace admission", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ type: "text", text: "Ready." }] }],
        });
        gyms.add(gym);
        const { workspaceId } = (await gym.client.getAgent(gym.defaultSessionId)).agent;

        await gym.send("Inspect the available tools.");
        for (const name of ["service_start", "list_services", "service_input", "service_stop"])
            expect(gym.inference.lastTools()).not.toContain(name);
        expect(gym.inference.last?.instructions).not.toContain("dedicated service tools");

        const serviceId = "retiredservice";
        const unavailable = { status: 501, code: "unsupported" };
        await expect(gym.client.listWorkspaceServices(workspaceId)).rejects.toMatchObject(
            unavailable,
        );
        await expect(gym.client.getWorkspaceService(workspaceId, serviceId)).rejects.toMatchObject(
            unavailable,
        );
        await expect(
            gym.client.inputWorkspaceService(workspaceId, serviceId, { readerId: "view" }),
        ).rejects.toMatchObject(unavailable);
        await expect(gym.client.stopWorkspaceService(workspaceId, serviceId)).rejects.toMatchObject(
            unavailable,
        );
        await expect(
            gym.client.issueWorkspaceServiceAccessToken(workspaceId, serviceId),
        ).rejects.toMatchObject(unavailable);
        await expect(gym.client.listWorkspaceServices("missingworkspace")).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });

        const path = `/v0/workspaces/${workspaceId}/services/${serviceId}/proxy`;
        expect(await connectStatus(gym, path, gym.token)).toBe(501);
        expect(await connectStatus(gym, path, "wrong-token")).toBe(401);
        expect(
            await connectStatus(
                gym,
                `/v0/workspaces/missingworkspace/services/${serviceId}/proxy`,
                gym.token,
            ),
        ).toBe(404);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});

function connectStatus(gym: AgentGym, path: string, token: string): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
        const call = request({
            socketPath: gym.socketPath,
            method: "CONNECT",
            path,
            headers: { authorization: `Bearer ${token}` },
        });
        call.once("error", reject);
        call.once("connect", (response, socket) => {
            socket.destroy();
            resolve(response.statusCode);
        });
        call.setTimeout(10_000, () =>
            call.destroy(new Error("Service retirement did not answer.")),
        );
        call.end();
    });
}
