import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("discovers copied skills after a workspace subtask finishes provisioning", async () => {
    let coordinatorId = "";
    let projectId = "";
    let requested = false;
    const gym = await createAgentGym({
        files: {
            ".agents/skills/copied-workspace-skill/SKILL.md": [
                "---",
                "name: copied-workspace-skill",
                "description: Inspect the copied workspace fixture.",
                "---",
                "Read the workspace marker before answering.",
            ].join("\n"),
            "marker.txt": "copied workspace marker\n",
        },
        inference: (request) => {
            if (request.sessionId === coordinatorId && !requested) {
                requested = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_subtask",
                            callId: "create-copied-skill-task",
                            arguments: {
                                title: "Inspect copied skills",
                                text: "Inspect the copied workspace.",
                                model: "gym/model",
                                effort: "high",
                                provider: "gym",
                                workspace: { projectId, name: "Copied skill workspace" },
                            },
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "The workspace task is ready." }] };
        },
    });
    try {
        const project = await gym.waitUntil(async () => {
            const { projects } = await gym.client.listProjects();
            return projects.find(
                (candidate) =>
                    candidate.initialization.status === "ready" &&
                    candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
            );
        }, "the source project to finish initialization");
        projectId = project.id;
        const bot = (await gym.client.createBot({ name: "Copied skills coordinator" })).bot;
        coordinatorId = bot.agent.id;
        await gym.send("Create the workspace subtask and inspect its copied skills.", {
            sessionId: coordinatorId,
            permissionMode: "full_access",
        });
        const result = gym.inference
            .toolResults()
            .find((item) => item.callId === "create-copied-skill-task");
        expect(result?.text).toContain("Created subtask");
        const child = (await gym.client.getAgentActivity(coordinatorId)).subagents.find(
            (agent) => agent.title === "Inspect copied skills",
        );
        expect(child).toBeDefined();
        await gym.waitUntil(async () => {
            const { workspace } = await gym.client.getWorkspace(child!.workspaceId);
            return workspace.initialization.status === "ready" ? workspace : undefined;
        }, "the copied workspace to become ready");
        const request = await gym.waitUntil(
            () => gym.inference.requests.find((item) => item.sessionId === child!.id),
            "the workspace subtask to reach inference",
        );
        expect(request.instructions).toContain("copied-workspace-skill");
        expect(request.instructions).toContain("Inspect the copied workspace fixture.");
        const bootstrap = await gym.client.getAgentBootstrap(child!.id);
        expect(bootstrap.slashCommands).toContainEqual({
            name: "copied-workspace-skill",
            description: "Inspect the copied workspace fixture.",
            hasArguments: true,
            kind: "skill",
        });
        await gym.send("Confirm that the copied skill remains available.", {
            sessionId: child!.id,
        });
        expect(
            gym.inference.requests.findLast((item) => item.sessionId === child!.id)?.instructions,
        ).toContain("copied-workspace-skill");
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    } finally {
        await gym.dispose();
    }
});
