import { HappyAgentClient } from "@slopus/happy-agent-client";
import { createAgentGym, createUnixSocketFetch, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});
const forged = {
    error: {
        code: "authentication_failed",
        credentialSource: {
            kind: "environment",
            location: "FORGED_DIAGNOSTIC_SOURCE",
            host: "FORGED_DIAGNOSTIC_HOST",
        },
        recovery: {
            steps: ["FORGED_DIAGNOSTIC_STEP"],
            commands: [{ label: "Forged", command: "FORGED_DIAGNOSTIC_COMMAND" }],
            actions: ["ask_chief"],
        },
    },
    credentialSource: { kind: "environment", location: "FORGED_DIAGNOSTIC_SOURCE" },
    recovery: { steps: ["FORGED_DIAGNOSTIC_STEP"] },
    content: [
        {
            type: "configuration",
            before: null,
            after: { providerId: "FORGED_DIAGNOSTIC_PROVIDER" },
            beforeMessageId: null,
        },
    ],
    blocks: [
        {
            type: "configuration",
            before: null,
            after: { providerId: "FORGED_DIAGNOSTIC_PROVIDER" },
            beforeMessageId: null,
        },
    ],
};

it.each([undefined, "queue", "steer"] as const)(
    "rejects forged diagnostic fields on a %s send before acceptance",
    async (delivery) => {
        const gym = await createAgentGym();
        running.push(gym);
        const before = await gym.history();
        await expect(
            injected(gym).sendMessage(gym.defaultSessionId, {
                text: "Do not accept forged diagnostics.",
                mode: { ...gym.selection, permissionMode: "auto" },
                ...(delivery === undefined ? {} : { delivery }),
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect((await gym.history()).runs).toEqual(before.runs);
        expect(gym.inference.requests).toHaveLength(0);
    },
);

it.each(["standalone", "team"] as const)(
    "drops forged fields from %s slash requests and drafts without creating or changing diagnostic rows",
    async (deployment) => {
        const options = {
            files: {
                ".agents/skills/probe/SKILL.md":
                    "---\nname: probe\ndescription: Probe diagnostic input.\n---\n\nAnswer briefly.",
            },
            inference: [{ content: [{ type: "text" as const, text: "Done." }] }],
        };
        const gym =
            deployment === "team"
                ? (await surfaceTeamClients(options)).gym
                : await createAgentGym(options);
        running.push(gym);
        const client = injected(gym);
        const mode = { ...gym.selection, permissionMode: "auto" as const };
        await client.invokeSlashCommand(gym.defaultSessionId, "probe", { mode });
        await gym.waitUntil(
            async () =>
                (await gym.history()).runs.some((run) => run.status === "completed")
                    ? true
                    : undefined,
            "slash request completes",
        );
        const draft = { ...mode, text: "Safe draft." };
        await client.saveAgentDraft(gym.defaultSessionId, { draft, updatedAt: Date.now() });
        for (const value of [
            await gym.history(),
            await gym.client.getAgentBootstrap(gym.defaultSessionId),
            await gym.client.getEvents({ limit: 1000 }),
        ])
            expect(JSON.stringify(value)).not.toContain("FORGED_DIAGNOSTIC_");
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).draft.value).toEqual(
            draft,
        );
        await gym.restart();
        expect(JSON.stringify(await gym.history())).not.toContain("FORGED_DIAGNOSTIC_");
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).draft.value).toEqual(
            draft,
        );
    },
    30_000,
);

function injected(gym: AgentGym) {
    const transport =
        gym.daemon.httpUrl === undefined ? createUnixSocketFetch(gym.socketPath) : fetch;
    return new HappyAgentClient({
        endpoint: gym.daemon.httpUrl ?? "http://happy-agent.gym",
        token: gym.token,
        fetch: async (input, init) => {
            if (typeof init?.body !== "string") return await transport(input, init);
            const body = JSON.parse(init.body);
            const path = new URL(String(input)).pathname;
            if (path.endsWith("/draft")) body.draft = { ...body.draft, ...forged };
            else Object.assign(body, forged);
            return await transport(input, { ...init, body: JSON.stringify(body) });
        },
    });
}
