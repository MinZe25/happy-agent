import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { HappyAgentEvent } from "@slopus/happy-agent-client";
import { expect, it, vi } from "vitest";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

it.each(["output", "terminal failure"] as const)(
    "keeps one concrete observation across a native transport retry followed by %s",
    async (outcome) => {
        let requests = 0;
        const server = createServer((request, response) => {
            request.resume();
            requests += 1;
            if (requests === 1 || outcome === "terminal failure") {
                response.writeHead(requests === 1 ? 500 : 401, {
                    "content-type": "application/json",
                    "retry-after-ms": "1",
                });
                response.end(
                    JSON.stringify({
                        error: {
                            type: requests === 1 ? "server_error" : "authentication_error",
                            message:
                                requests === 1
                                    ? "Synthetic retryable transport failure."
                                    : "Synthetic terminal credential failure.",
                        },
                    }),
                );
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                        id: "answer",
                        type: "message",
                        role: "assistant",
                        status: "in_progress",
                        content: [],
                    },
                },
                {
                    type: "response.content_part.added",
                    item_id: "answer",
                    output_index: 0,
                    content_index: 0,
                    part: { type: "output_text", text: "", annotations: [] },
                },
                {
                    type: "response.output_text.delta",
                    item_id: "answer",
                    output_index: 0,
                    content_index: 0,
                    delta: "Recovered after retry.",
                },
                {
                    type: "response.output_text.done",
                    item_id: "answer",
                    output_index: 0,
                    content_index: 0,
                    text: "Recovered after retry.",
                },
                {
                    type: "response.completed",
                    response: {
                        id: "recovered",
                        status: "completed",
                        output: [],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    },
                },
            ])
                response.write(`data: ${JSON.stringify(event)}\n\n`);
            response.end("data: [DONE]\n\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing retry fixture address.");
        const fixture = await credentialWriterRuntime("owner", {
            providerConfiguration: `[providers]
default_enable = false
[providers.private_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-retry-key"
base_url = "http://127.0.0.1:${address.port}/v1"
transport = "sse"
`,
        });
        try {
            // Fixture-only generated configuration: the real provider owns the retry policy.
            await writeFile(
                fixture.runtime.modules.config.configuration.paths.runtimeConfigPath,
                "[settings]\ninference_max_retries = 1\n",
            );
            await fixture.restart();
            expect(
                fixture.runtime.modules.config.configuration.values.settings.inferenceMaxRetries,
            ).toBe(1);
            const specifier = "../../sources/config/impl/ProviderExecutionObservations.js";
            const module = await import(specifier).catch(() => undefined);
            const prototype = module?.ProviderExecutionObservations?.prototype;
            const starts: string[] = [];
            const claims: string[] = [];
            const completed: Array<{ operationId: string; attempts: unknown }> = [];
            const discards: unknown[] = [];
            if (prototype !== undefined) {
                const begin = prototype.begin;
                vi.spyOn(prototype, "begin").mockImplementation(function (
                    this: unknown,
                    ...args: unknown[]
                ) {
                    if (args[0] === fixture.agent.id) starts.push(args[1] as string);
                    return begin.apply(this, args);
                });
                const claim = prototype.claim;
                vi.spyOn(prototype, "claim").mockImplementation(function (
                    this: unknown,
                    ...args: unknown[]
                ) {
                    if (args[0] === fixture.agent.id) claims.push(args[1] as string);
                    return claim.apply(this, args);
                });
                const end = prototype.end;
                vi.spyOn(prototype, "end").mockImplementation(function (
                    this: { read(...args: unknown[]): unknown },
                    ...args: unknown[]
                ) {
                    if (args[0] === fixture.agent.id) {
                        const attempts = this.read(...args);
                        if (attempts !== undefined)
                            completed.push({ operationId: args[1] as string, attempts });
                    }
                    return end.apply(this, args);
                });
                const discard = prototype.discard;
                vi.spyOn(prototype, "discard").mockImplementation(function (
                    this: unknown,
                    ...args: unknown[]
                ) {
                    discards.push(args[0]);
                    return discard.apply(this, args);
                });
            }
            let retryEvents = 0;
            const stop = fixture.runtime.modules.events.subscribe((event) => {
                if (
                    event.agentId === fixture.agent.id &&
                    event.type === "provider.event" &&
                    JSON.stringify(event.payload).includes('"type":"retrying"')
                )
                    retryEvents += 1;
            });
            try {
                const before = (await fixture.owner.getEvents()).latestCursor;
                const sent = await fixture.owner.sendMessage(fixture.agent.id, {
                    text: "Exercise the native retry.",
                    mode: writerMode,
                });
                await vi.waitFor(
                    async () => {
                        const page = await fixture.owner.getMessages(fixture.agent.id);
                        expect(
                            page.runs.find((run) =>
                                run.messages.some((message) => message.id === sent.message.id),
                            )?.status,
                        ).toBe(outcome === "output" ? "completed" : "failed");
                        expect(
                            (await fixture.owner.getEvents({ after: before })).events.some(
                                (event) => event.type === "run.finished",
                            ),
                        ).toBe(true);
                    },
                    { timeout: 10_000, interval: 10 },
                );
                expect(requests).toBe(2);
                expect(retryEvents).toBe(1);
                expect.soft(starts).toHaveLength(1);
                expect.soft(claims).toEqual(["inference"]);
                expect.soft(completed).toHaveLength(1);
                expect.soft(completed[0]?.operationId).toBe(starts[0]);
                expect
                    .soft(completed[0]?.attempts)
                    .toMatchObject([{ mode: { providerId: "private_account" } }]);
                expect(discards).toEqual([]);
                const messages = (await fixture.owner.getMessages(fixture.agent.id)).runs.flatMap(
                    (run) => run.messages,
                );
                const journal = (await fixture.owner.getEvents({ after: before })).events;
                const created = journal.flatMap((event) =>
                    event.type === "message.created" && event.payload.agentId === fixture.agent.id
                        ? [event.payload.message]
                        : [],
                );
                const configurations = messages.filter((message) =>
                    message.content.some((block) => block.type === "configuration"),
                );
                expect.soft(configurations).toHaveLength(1);
                expect.soft(configurations[0]?.content).toEqual([
                    {
                        type: "configuration",
                        before: null,
                        after: { ...writerMode, providerType: "codex", account: null },
                        beforeMessageId: sent.message.id,
                    },
                ]);
                expect
                    .soft(foldMessageIds(journal, fixture.agent.id))
                    .toEqual(messages.map((message) => message.id));
                expect
                    .soft(
                        created.filter((message) =>
                            configurations.some((row) => row.id === message.id),
                        ),
                    )
                    .toEqual(configurations);
                const provisionalId = created.find((message) => message.role === "agent")?.id;
                expect(provisionalId).toBeDefined();
                const lifecycle = journal.flatMap((event) =>
                    event.type === "message.created" && event.payload.message.id === provisionalId
                        ? ["created"]
                        : event.type === "message.deleted" &&
                            event.payload.messageId === provisionalId
                          ? ["deleted"]
                          : [],
                );
                expect(lifecycle).toEqual(
                    outcome === "output"
                        ? ["created", "deleted", "created"]
                        : ["created", "deleted", "created", "deleted"],
                );
                const configurationIndex = created.findIndex(
                    (message) => message.id === configurations[0]?.id,
                );
                expect.soft(configurationIndex).toBeGreaterThanOrEqual(0);
                expect
                    .soft(configurationIndex)
                    .toBeLessThan(created.findIndex((message) => message.id === provisionalId));
                expect(
                    journal.filter(
                        (event) =>
                            event.type === "message.deleted" &&
                            event.payload.messageId === configurations[0]?.id,
                    ),
                ).toEqual([]);
                if (outcome === "output") {
                    // message.created is initially empty; its stable identity orders the later text.
                    const storedOutput = messages.find(
                        (message) =>
                            message.role === "agent" &&
                            message.content.some(
                                (block) =>
                                    block.type === "text" &&
                                    block.text === "Recovered after retry.",
                            ),
                    );
                    expect(storedOutput).toBeDefined();
                    expect(storedOutput?.id).toBe(provisionalId);
                } else
                    expect
                        .soft(
                            messages
                                .filter((message) => message.role === "service")
                                .find((message) => message.error !== undefined)?.error,
                        )
                        .toMatchObject({
                            code: "authentication_failed",
                            mode: { providerId: "private_account" },
                            credentialSource: {
                                kind: "configuration",
                                location: "providers.private_account.api_key",
                            },
                        });
            } finally {
                stop();
            }
        } finally {
            await fixture.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            vi.restoreAllMocks();
        }
    },
    30_000,
);

/** Replay the existing native provisional-message lifecycle in journal cursor order. */
function foldMessageIds(events: readonly HappyAgentEvent[], agentId: string): string[] {
    const ids: string[] = [];
    for (const event of events) {
        if (event.type === "message.created" && event.payload.agentId === agentId) {
            expect.soft(ids).not.toContain(event.payload.message.id);
            ids.push(event.payload.message.id);
        } else if (event.type === "message.deleted" && event.payload.agentId === agentId) {
            const index = ids.indexOf(event.payload.messageId);
            expect.soft(index).toBeGreaterThanOrEqual(0);
            if (index >= 0) ids.splice(index, 1);
        }
    }
    return ids;
}
