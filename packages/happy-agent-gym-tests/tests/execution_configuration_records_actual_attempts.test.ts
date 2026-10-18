import type { MessageMode } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});
const modelIds = ["gym/model-a", "gym/model-b", "gym/model-c"];
const mode = (modelId: string): MessageMode => ({
    providerId: "gym",
    modelId,
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
});

it("coalesces queued A to B to C into actual A to C, anchors committed messages and survives same-mode slash and restart", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let mainCalls = 0;
    const gym = await createAgentGym({
        models: modelIds.map((id) => ({
            id,
            providerId: "gym",
            name: id,
            defaultEffort: "medium",
            effortLevels: ["medium"],
        })),
        files: {
            ".agents/skills/probe/SKILL.md":
                "---\nname: probe\ndescription: Inspect the execution mode.\n---\n\nAnswer briefly.",
        },
        inference: async (request) => {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "Execution modes" }] };
            if (mainCalls++ === 0) await gate;
            return { content: [{ type: "text", text: `Executed ${request.model}.` }] };
        },
    });
    running.push(gym);
    try {
        const a = await gym.client.sendMessage(gym.defaultSessionId, {
            text: "First actual mode.",
            mode: mode(modelIds[0]!),
        });
        await gym.waitUntil(
            () => (mainCalls === 1 ? true : undefined),
            "the first execution to begin",
        );
        const b = await gym.client.sendMessage(gym.defaultSessionId, {
            text: "Queued intermediate mode.",
            delivery: "queue",
            mode: mode(modelIds[1]!),
        });
        const c = await gym.client.sendMessage(gym.defaultSessionId, {
            text: "Queued final mode.",
            delivery: "queue",
            mode: mode(modelIds[2]!),
        });
        release();
        await settled(gym, c.message.id);
        const first = await gym.client.getMessages(gym.defaultSessionId);
        const records = configurations(first);
        // API.md:4614-4634: baseline, coalescing and same-run committed-message anchors.
        expect
            .soft(records.map((entry) => entry.block.after.modelId))
            .toEqual([modelIds[0], modelIds[2]]);
        expect.soft(records[0]?.block).toMatchObject({
            before: null,
            after: mode(modelIds[0]!),
            beforeMessageId: a.message.id,
        });
        expect
            .soft(records[1]?.block)
            .toMatchObject({ before: mode(modelIds[0]!), after: mode(modelIds[2]!) });
        for (const record of records) {
            expect(record.block.beforeMessageId).not.toBeNull();
            expect(
                first.runs
                    .find((run) => run.id === record.runId)
                    ?.messages.map((message) => message.id),
            ).toContain(record.block.beforeMessageId);
            // API.md:4301-4308: unknown provenance stays absent, never derived from a scripted route name.
            expect(record.block.after).not.toHaveProperty("account");
            expect(record.block.after).not.toHaveProperty("providerType");
        }
        const requests = gym.inference.requests.filter(
            (request) => !request.sessionId.startsWith("naming:"),
        );
        expect(requests.map((request) => request.model)).not.toContain(modelIds[1]);
        for (const request of requests)
            expect(JSON.stringify(request.messages)).not.toContain('"type":"configuration"');
        // API.md:4310-4318: requested selections remain requested, not rewritten by execution snapshots.
        for (const submitted of [a, b, c])
            expect(
                first.runs
                    .flatMap((run) => run.messages)
                    .find((message) => message.id === submitted.message.id),
            ).toMatchObject({ mode: submitted.message.mode });
        const beforeSlash = first.runs.length;
        await gym.client.invokeSlashCommand(gym.defaultSessionId, "probe", {
            mode: mode(modelIds[2]!),
        });
        await gym.waitUntil(async () => {
            const page = await gym.client.getMessages(gym.defaultSessionId);
            return page.runs.length > beforeSlash &&
                page.runs.every((run) => run.status === "completed")
                ? page
                : undefined;
        }, "the same-mode slash command to settle");
        // API.md:4621-4634: same mode emits no change and the baseline survives restart.
        expect
            .soft(configurations(await gym.client.getMessages(gym.defaultSessionId)))
            .toEqual(records);
        await gym.restart();
        expect
            .soft(configurations(await gym.client.getMessages(gym.defaultSessionId)))
            .toEqual(records);
        await gym.send("The same selection after restart.", { modelId: modelIds[2]! });
        expect
            .soft(configurations(await gym.client.getMessages(gym.defaultSessionId)))
            .toEqual(records);
        expect(gym.errors).toEqual([]);
    } finally {
        release();
    }
}, 60_000);

it("keeps scripted terminal source and provenance unknown while preserving the typed failure", async () => {
    const gym = await createAgentGym({
        inference: [
            {
                error: {
                    message: "Synthetic authentication failure.",
                    providerError: { type: "authentication" },
                },
            },
        ],
    });
    running.push(gym);
    await gym.send("Exercise unknown credential provenance.");
    const page = await gym.client.getMessages(gym.defaultSessionId);
    const error = page.runs
        .flatMap((run) => run.messages)
        .filter((message) => message.role === "service")
        .find(
            (message) =>
                message.role === "service" &&
                message.content.some(
                    (block) =>
                        block.type === "text" &&
                        block.text.includes("Synthetic authentication failure."),
                ),
        );
    // API.md:4688-4706: mode may be available without an observed source or account identity.
    expect.soft(error?.error).toMatchObject({
        code: "authentication_failed",
        credentialSource: null,
        mode: { providerId: "gym", modelId: gym.selection.modelId },
    });
    expect(error?.error?.mode ?? {}).not.toHaveProperty("account");
    expect(error?.error?.mode ?? {}).not.toHaveProperty("providerType");
    expect(error).not.toHaveProperty("error.recovery.commands");
    expect.soft(configurations(page)).toHaveLength(1);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("records the actually selected smart-route entry without changing the requested alias", async () => {
    const modelId = "openai/gpt-5.6-sol";
    const gym = await createAgentGym({
        routeConfiguredProviders: true,
        models: ["gym", "router"].map((providerId) => ({
            id: modelId,
            providerId,
            name: "Fixture model",
            defaultEffort: "medium",
            effortLevels: ["medium"],
        })),
        config: `[providers]\ndefault_enable = false\n[providers.gym]\ntype = "codex"\nenabled = true\n[providers.router]\ntype = "smart"\nenabled = true\nproviders = ["gym"]\n`,
        inference: [
            {
                error: {
                    message: "First attempted account rejected.",
                    providerError: { type: "authentication" },
                },
            },
        ],
    });
    running.push(gym);
    const submitted = await gym.client.sendMessage(gym.defaultSessionId, {
        text: "Try the pool.",
        mode: { ...mode(modelId), providerId: "router" },
    });
    await settled(gym, submitted.message.id);
    const page = await gym.client.getMessages(gym.defaultSessionId);
    const records = configurations(page);
    // API.md:4310-4318, 4621-4634: the concrete attempt is an output snapshot, never the requested routing alias.
    expect.soft(records).toHaveLength(1);
    expect
        .soft(new Set(records.map((record) => record.block.after.providerId)))
        .toEqual(new Set(["gym"]));
    expect.soft(records[0]?.block.beforeMessageId).toBe(submitted.message.id);
    const error = page.runs
        .flatMap((run) => run.messages)
        .filter((message) => message.role === "service")
        .find((message) => message.error !== undefined);
    expect.soft(error?.error?.mode?.providerId).toBe("gym");
    expect.soft(error?.error?.credentialSource).toBeNull();
    expect(
        page.runs
            .flatMap((run) => run.messages)
            .find((message) => message.id === submitted.message.id),
    ).toMatchObject({ mode: { providerId: "router" } });
    expect(await gym.client.getAgentMode(gym.defaultSessionId)).toMatchObject({
        mode: { providerId: "router" },
    });
    expect(gym.inference.requests).toHaveLength(1);
    expect(gym.errors).toEqual([]);
}, 30_000);

async function settled(gym: AgentGym, messageId: string) {
    await gym.waitUntil(async () => {
        const page = await gym.client.getMessages(gym.defaultSessionId);
        return page.runs.some(
            (run) =>
                run.status !== "running" &&
                run.messages.some((message) => message.id === messageId),
        )
            ? page
            : undefined;
    }, "the accepted message to settle");
}

function configurations(page: Awaited<ReturnType<AgentGym["client"]["getMessages"]>>) {
    return page.runs.flatMap((run) =>
        run.messages.flatMap((message) =>
            message.content
                .filter((block) => block.type === "configuration")
                .map((block) => ({ messageId: message.id, runId: run.id, block })),
        ),
    );
}
