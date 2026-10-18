import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("preserves the exact numeric code when a terminal exits normally", async () => {
    const gym = await createAgentGym();
    try {
        const workspaceId = await readyRoot(gym);
        const opened = (await gym.client.openTerminal(workspaceId, { command: "exit 7" })).terminal;
        const exited = await gym.waitUntil(async () => {
            const { terminals } = await gym.client.listTerminals(workspaceId);
            return terminals.find((item) => item.id === opened.id && item.status === "exited");
        }, "the normal terminal exit to be observable");
        expect(exited).toMatchObject({ id: opened.id, status: "exited", exitCode: 7 });
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
});

it("distinguishes a deliberately killed terminal from a normal numeric exit", async () => {
    const gym = await createAgentGym();
    try {
        const workspaceId = await readyRoot(gym);
        const opened = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        expect(opened.status).toBe("running");
        const stopped = (await gym.client.stopTerminal(workspaceId, opened.id)).terminal;
        expect(stopped).toMatchObject({ id: opened.id, status: "exited", exitCode: null });
        expect(stopped.version).not.toBe(opened.version);
        const readBack = (await gym.client.listTerminals(workspaceId)).terminals.find(
            (item) => item.id === opened.id,
        );
        expect(readBack).toEqual(stopped);
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
});

async function readyRoot(gym: AgentGym): Promise<string> {
    return await gym.waitUntil(async () => {
        const { projects } = await gym.client.listProjects();
        return projects.find(
            (item) => item.status === "active" && item.initialization.status === "ready",
        )?.id;
    }, "the terminal fixture's root project to become ready");
}
