import type { MessageMode } from "@slopus/happy-agent-client";
import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("observes changed configurations and a typed failure after a daemon restart without losing the baseline", async () => {
    const modelIds = ["gym/before-restart", "gym/after-restart", "gym/restarted-failure"];
    const mode = (modelId: string): MessageMode => ({
        providerId: "gym",
        modelId,
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto",
    });
    const gym = await createAgentGym({
        models: modelIds.map((id) => ({
            id,
            providerId: "gym",
            name: "Restart fixture model",
            defaultEffort: "medium",
            effortLevels: ["medium"],
        })),
        inference: [
            { content: [{ type: "text", text: "Before restart." }] },
            { content: [{ type: "text", text: "After restart." }] },
            {
                error: {
                    message: "Synthetic failure after restart.",
                    providerError: { type: "authentication" },
                },
            },
        ],
    });
    try {
        const first = await gym.send("Establish a baseline.", { modelId: modelIds[0]! });
        const before = await gym.client.getMessages(gym.defaultSessionId);
        const originalConfiguration = before.runs
            .flatMap((run) => run.messages)
            .find((message) => message.content.some((block) => block.type === "configuration"));
        expect(originalConfiguration).toBeDefined();
        await gym.restart();
        const cursor = (await gym.client.getEvents()).cursor;
        const second = await gym.send("Change model after restart.", { modelId: modelIds[1]! });
        const third = await gym.send("Fail after another model change.", {
            modelId: modelIds[2]!,
        });
        const page = await gym.client.getMessages(gym.defaultSessionId);
        const messages = page.runs.flatMap((run) => run.messages);
        const configurations = messages.filter((message) =>
            message.content.some((block) => block.type === "configuration"),
        );
        expect.soft(configurations.map((message) => message.content)).toEqual([
            [
                {
                    type: "configuration",
                    before: null,
                    after: mode(modelIds[0]!),
                    beforeMessageId: first.id,
                },
            ],
            [
                {
                    type: "configuration",
                    before: mode(modelIds[0]!),
                    after: mode(modelIds[1]!),
                    beforeMessageId: second.id,
                },
            ],
            [
                {
                    type: "configuration",
                    before: mode(modelIds[1]!),
                    after: mode(modelIds[2]!),
                    beforeMessageId: third.id,
                },
            ],
        ]);
        expect.soft(configurations[0]).toEqual(originalConfiguration);
        const failure = messages
            .filter((message) => message.role === "service")
            .find((message) => message.error !== undefined);
        expect.soft(failure?.error).toMatchObject({
            code: "authentication_failed",
            mode: mode(modelIds[2]!),
            credentialSource: null,
        });
        const events = (await gym.client.getEvents({ after: cursor })).events;
        const created = events.flatMap((event) =>
            event.type === "message.created" && event.payload.agentId === gym.defaultSessionId
                ? [event.payload.message]
                : [],
        );
        const postRestart = page.runs
            .filter((run) => run.id === second.runId || run.id === third.runId)
            .flatMap((run) => run.messages);
        expect
            .soft(created.map((message) => message.id))
            .toEqual(postRestart.map((message) => message.id));
        expect
            .soft(
                created.filter((message) =>
                    configurations.slice(1).some((row) => row.id === message.id),
                ),
            )
            .toEqual(configurations.slice(1));
        expect.soft(created.find((message) => message.id === failure?.id)).toEqual(failure);
        const afterRestartAssistant = messages.find(
            (message) =>
                message.role === "agent" &&
                message.content.some(
                    (block) => block.type === "text" && block.text === "After restart.",
                ),
        );
        const secondConfigurationIndex = created.findIndex(
            (message) => message.id === configurations[1]?.id,
        );
        const thirdConfigurationIndex = created.findIndex(
            (message) => message.id === configurations[2]?.id,
        );
        expect.soft(secondConfigurationIndex).toBeGreaterThanOrEqual(0);
        expect.soft(thirdConfigurationIndex).toBeGreaterThanOrEqual(0);
        expect
            .soft(created.findIndex((message) => message.id === afterRestartAssistant?.id))
            .toBeGreaterThan(secondConfigurationIndex);
        expect
            .soft(created.findIndex((message) => message.id === failure?.id))
            .toBeGreaterThan(thirdConfigurationIndex);
        expect(gym.inference.requests.map((request) => request.model)).toEqual(modelIds);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
}, 60_000);
