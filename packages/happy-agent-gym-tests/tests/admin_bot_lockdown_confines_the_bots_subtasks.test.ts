import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const DEFAULTS = { allowedSecretIds: null, crossWorkspace: true, compute: { type: "host" } };
const LOCKED = {
    allowedSecretIds: ["allowedtoken"],
    crossWorkspace: false,
    compute: { type: "host" },
};
const REVIEWER_CONTRACT = "end your final message with your verdict inside a <review> block";

/**
 * A gym where each agent runs exactly the tool call it is asked for, and every Auto review is
 * refused and recorded, so a scenario can tell what was reviewed from what was not.
 */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const reviews: string[] = [];
    const gym = await createAgentGym({
        permissionMode: "auto",
        timeoutMs: 20_000,
        inference: (request: GymInferenceRequest): GymTurn => {
            if (request.instructions.includes(REVIEWER_CONTRACT)) {
                reviews.push(JSON.stringify(request.messages));
                return {
                    content: [
                        {
                            type: "text",
                            text: "<review><risk_level>high</risk_level><user_authorization>low</user_authorization><outcome>deny</outcome><rationale>Scripted refusal.</rationale></review>",
                        },
                    ],
                };
            }
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(
        agentId: string,
        name: string,
        args: Record<string, unknown>,
        permissionMode: "auto" | "full_access" = "auto",
    ) {
        const callId = `lockdown_call_${++callIndex}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode,
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            `the ${name} result`,
        );
    }
    const offered = (agentId: string): readonly string[] =>
        gym.inference.requests
            .filter((request) => request.sessionId === agentId)
            .at(-1)
            ?.tools.map((tool) => tool.name) ?? [];
    return { gym, call, offered, reviews };
}

describe("an admin bot locks down another bot", () => {
    it("confines the bot's subtask to its allowed secrets and its own agents", async () => {
        const { gym, call, offered, reviews } = await harness();
        for (const id of ["allowedtoken", "forbiddentoken"]) {
            await gym.client.createSecret({
                id,
                description: `The ${id} credentials`,
                environment: { [id.toUpperCase()]: `${id}-value` },
            });
        }
        const worker = (await gym.client.createBot({ name: "Locked worker" })).bot;
        const admin = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;

        const read = await call(admin.agent.id, "get_bot_settings", { botId: worker.id });
        expect(read.text).toContain(
            `Current value, to pass as previous: ${JSON.stringify(DEFAULTS)}`,
        );

        // Narrowing is applied directly in Auto: nothing is widened, so nothing is reviewed.
        const locked = await call(admin.agent.id, "update_bot_settings", {
            botId: worker.id,
            previous: DEFAULTS,
            allowedSecretIds: ["allowedtoken"],
            crossWorkspace: false,
        });
        expect(locked.text).toContain("Updated the settings of bot");
        expect(locked.text).toContain('Secrets: only "allowedtoken".');
        expect(reviews).toEqual([]);

        // The locked bot keeps creating subtasks in its own folder, but not in a project.
        const created = await call(worker.agent.id, "create_subtask", {
            title: "Locked subtask",
            text: "Work inside the bot.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        });
        expect(created.text).toContain("Created subtask");
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created.text)![1]!;
        const project = await gym.waitUntil(async () => {
            const { projects } = await gym.client.listProjects();
            const root = projects.find((candidate) =>
                candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
            );
            return root?.initialization.status === "ready" ? root : undefined;
        }, "the root project to be ready");
        const inProject = await call(worker.agent.id, "create_subtask", {
            title: "Escaping subtask",
            text: "Work in the project.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
            workspace: { projectId: project.id, name: "Escape" },
        });
        expect(inProject.text).toContain("keep its subtasks in the bot's own folder");

        // Secrets the bot does not allow are not there for its subtask.
        const listed = await call(subtaskId, "list_secrets", {});
        expect(listed.text).toContain("allowedtoken");
        expect(listed.text).not.toContain("forbiddentoken");
        const referenced = await call(subtaskId, "reference_secret", { id: "forbiddentoken" });
        expect(referenced.text).toContain("not registered");
        const attached = await call(
            subtaskId,
            "attach_secret",
            { secretId: "forbiddentoken" },
            "full_access",
        );
        expect(attached.text).toContain('Secret "forbiddentoken" is not available to this bot.');
        expect((await gym.client.listSecretAttachments("forbiddentoken")).attachments).toEqual([]);

        // Outside the bot's tree, messages do not go; inside it, they do.
        const outside = await call(subtaskId, "send_agent_message", {
            toAgentId: gym.defaultSessionId,
            text: "LOCKED_SUBTASK_LEAK",
        });
        expect(outside.text).toContain("message only the bot's own agents");
        const inside = await call(subtaskId, "send_agent_message", {
            toAgentId: worker.agent.id,
            text: "LOCKED_SUBTASK_REPORT",
        });
        expect(inside.text).not.toContain("only the bot's own agents");
        await gym.waitUntil(
            async () =>
                JSON.stringify(await gym.client.getMessages(worker.agent.id)).includes(
                    "LOCKED_SUBTASK_REPORT",
                )
                    ? true
                    : undefined,
            "the report to reach the bot",
        );
        expect(JSON.stringify(await gym.client.getMessages(gym.defaultSessionId))).not.toContain(
            "LOCKED_SUBTASK_LEAK",
        );

        // The locked bot and its subtask are told, and lose the catalogs beyond the bot.
        const subtaskRequest = gym.inference.requests
            .filter((request) => request.sessionId === subtaskId)
            .at(-1)!;
        expect(subtaskRequest.instructions).toContain("This bot's owner restricts");
        expect(subtaskRequest.instructions).not.toContain(
            "Cross-workspace agent messaging is enabled",
        );
        for (const tool of ["list_bots", "list_projects", "list_workspaces", "create_task"]) {
            expect(offered(worker.agent.id)).not.toContain(tool);
        }
        expect(offered(admin.agent.id)).toContain("list_bots");

        // Widening is reviewed, and a refused review changes nothing.
        const widened = await call(admin.agent.id, "update_bot_settings", {
            botId: worker.id,
            previous: LOCKED,
            crossWorkspace: true,
        });
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toContain(
            "restoring reach to other projects, workspaces, tasks, bots, and agents outside the bot",
        );
        expect(widened.text).not.toContain("Updated the settings of bot");
        const after = await call(admin.agent.id, "get_bot_settings", { botId: worker.id });
        expect(after.text).toContain(JSON.stringify(LOCKED));

        expect(gym.errors).toEqual([]);
    }, 120_000);
});
