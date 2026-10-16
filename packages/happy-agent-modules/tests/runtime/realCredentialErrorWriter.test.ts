import { createServer } from "node:http";
import type { Message } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../sources/events/index.js";
import type { ApiEvent } from "../../sources/api/ApiEventJournal.js";
import { diagnosticRuntime } from "../support/diagnosticRuntime.js";
import {
    credentialWriterRuntime,
    writerMode,
    writerText,
} from "../support/credentialWriterRuntime.js";

const hasErrorSchema = Type.Object({ error: Type.Unknown() });
const failedProviderEventSchema = Type.Object(
    {
        event: Type.Object(
            { type: Type.Literal("done"), state: Type.Literal("error") },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

it("writes a typed terminal error from a genuine configured provider failure", async () => {
    const server = createServer((request, response) => {
        request.resume();
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
            JSON.stringify({
                error: {
                    type: "authentication_error",
                    message: "Authentication failed.\n\nRetry this conversation.",
                },
            }),
        );
    });
    let fixture: Awaited<ReturnType<typeof diagnosticRuntime>> | undefined;
    try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture port.");
        fixture = await diagnosticRuntime(`
[providers]
default_enable = false
[providers.private_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-fixture-key"
base_url = "http://127.0.0.1:${address.port}/v1"
transport = "sse"
[defaults]
provider = "private_account"
model = "openai/gpt-5.6-sol"
[settings]
inference_max_retries = 0
`);
        const { runtime, client } = fixture;
        const agent = fixture.agent!;
        const events: AgentEvent[] = [];
        const unsubscribe = runtime.modules.events.subscribe((event) => {
            if (event.agentId === agent.id) events.push(event);
        });
        try {
            await client.sendMessage(agent.id, {
                text: "Exercise a real terminal credential failure.",
                mode: {
                    providerId: "private_account",
                    modelId: "openai/gpt-5.6-sol",
                    effort: "medium",
                    serviceTier: null,
                    permissionMode: "auto",
                },
            });
            await vi.waitFor(
                async () =>
                    expect(
                        (await client.getMessages(agent.id)).runs.some(
                            (run) => run.status === "failed",
                        ),
                    ).toBe(true),
                { timeout: 10_000, interval: 10 },
            );
            const done = events.findLast(
                (event) =>
                    event.type === "provider.event" &&
                    (event.payload as { event?: { type?: string } }).event?.type === "done",
            );
            expect(done?.payload).toMatchObject({
                event: {
                    type: "done",
                    state: "error",
                    providerError: { type: "authentication", diagnostics: { status: 401 } },
                },
            });
            const history = await client.getMessages(agent.id);
            const messages = history.runs.flatMap((run) => run.messages);
            const error = history.runs
                .flatMap((run) => run.messages)
                .find(
                    (message) =>
                        message.role === "service" &&
                        message.content.some(
                            (block) =>
                                block.type === "text" &&
                                block.text.includes("Authentication failed."),
                        ),
                );
            expect(error).toMatchObject({
                error: {
                    code: "authentication_failed",
                    mode: {
                        providerId: "private_account",
                        providerType: "codex",
                        account: null,
                        modelId: "openai/gpt-5.6-sol",
                    },
                    credentialSource: {
                        kind: "configuration",
                        location: "providers.private_account.api_key",
                    },
                },
            });
            expect(
                messages.filter(
                    (message) =>
                        Value.Check(hasErrorSchema, message) && message.error !== undefined,
                ),
            ).toEqual([error]);
            for (const message of messages) {
                if (message.content.some((block) => block.type === "configuration"))
                    expect(message).not.toHaveProperty("error");
            }
            // API.md:4612-4615: the anchored configuration precedes the affected failure.
            const run = history.runs.find((entry) =>
                entry.messages.some((message) => message.id === error?.id),
            )!;
            const configurationIndex = run.messages.findIndex((message) =>
                message.content.some((block) => block.type === "configuration"),
            );
            expect(configurationIndex).toBeGreaterThanOrEqual(0);
            expect(configurationIndex).toBeLessThan(
                run.messages.findIndex((message) => message.id === error?.id),
            );
        } finally {
            unsubscribe();
        }
    } finally {
        await fixture?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}, 30_000);

describe.each(["owner", "member", "unresolved"] as const)("real writer for %s", (authority) => {
    describe.each(["initial runtime", "after restart"] as const)("%s", (lifetime) => {
        it.each(["history", "live", "replay", "pending"] as const)(
            "preserves the genuine failed attempt through %s without disclosing another caller's source",
            async (surface) => {
                const fixture = await credentialWriterRuntime(authority);
                let stopCounting: (() => void) | undefined;
                try {
                    let firstFailure: Message | undefined;
                    let priorErrorRows = 0;
                    if (lifetime === "after restart") {
                        firstFailure = await fail(fixture);
                        priorErrorRows = (await fixture.reader.getMessages(fixture.agent.id)).runs
                            .flatMap((run) => run.messages)
                            .filter(
                                (message) =>
                                    message.role === "service" &&
                                    message.content.some(
                                        (block) =>
                                            block.type === "text" &&
                                            block.text.includes(writerText),
                                    ),
                            ).length;
                        const original = await fixture.runtime.modules.history.message(
                            fixture.ctx,
                            fixture.agent.id,
                            firstFailure.id,
                        );
                        await fixture.restart();
                        const restored = (await fixture.reader.getMessages(fixture.agent.id)).runs
                            .flatMap((run) => run.messages)
                            .find((message) => message.id === firstFailure!.id);
                        expect(restored).toEqual(firstFailure);
                        expect(
                            await fixture.runtime.modules.history.message(
                                fixture.ctx,
                                fixture.agent.id,
                                firstFailure.id,
                            ),
                        ).toEqual(original);
                        check(restored!, authority === "owner");
                    }
                    const before = (await fixture.owner.getEvents()).latestCursor;
                    const rawBefore =
                        lifetime === "after restart"
                            ? await fixture.runtime.modules.history.read(
                                  fixture.ctx,
                                  fixture.agent.id,
                                  { limit: 100 },
                              )
                            : undefined;
                    const visibleBefore =
                        lifetime === "after restart"
                            ? await fixture.reader.getMessages(fixture.agent.id)
                            : undefined;
                    const visibleConfigurationIdsBefore = new Set(
                        visibleBefore?.runs
                            .flatMap((run) => run.messages)
                            .filter((message) =>
                                message.content.some((block) => block.type === "configuration"),
                            )
                            .map((message) => message.id),
                    );
                    let failedInferences = 0;
                    stopCounting = fixture.runtime.modules.events.subscribe((event) => {
                        if (
                            event.agentId === fixture.agent.id &&
                            event.type === "provider.event" &&
                            Value.Check(failedProviderEventSchema, event.payload)
                        )
                            failedInferences += 1;
                    });
                    const live =
                        surface === "live"
                            ? await fixture.stream(fixture.reader, before)
                            : undefined;
                    const restartLive =
                        lifetime === "after restart"
                            ? await fixture.stream(fixture.reader, before)
                            : undefined;
                    const failure = await fail(fixture, firstFailure?.id);
                    const canonical = await fixture.runtime.modules.history.message(
                        fixture.ctx,
                        fixture.agent.id,
                        failure.id,
                    );
                    const original = structuredClone(canonical);
                    let sourceEvent: ApiEvent | undefined;
                    await vi.waitFor(
                        () => {
                            sourceEvent = fixture.journal
                                .replay(before, undefined, 10_000)!
                                .events.find((event) => {
                                    const payload = event.payload as {
                                        runId?: string;
                                        message?: Message;
                                    };
                                    return (
                                        event.type === "message.created" &&
                                        payload.runId === canonical?.runId &&
                                        payload.message?.role === "service" &&
                                        payload.message.content.some(
                                            (block) =>
                                                block.type === "text" &&
                                                block.text.includes(writerText),
                                        )
                                    );
                                });
                            expect(sourceEvent).toBeDefined();
                        },
                        { timeout: 5_000, interval: 10 },
                    );
                    const emittedId = (sourceEvent!.payload as { message: Message }).message.id;
                    expect.soft(emittedId).toBe(failure.id);
                    let observed: Message;
                    if (surface === "history") observed = failure;
                    else if (surface === "live") {
                        const event = await live!.message(emittedId);
                        expect(event.cursor).toBe(sourceEvent!.cursor);
                        observed = event.payload.message;
                        // Consumer merge contract, not HappyReducer internals: published .92
                        // HappyReducer tracks agent facts/pending inputs, not transcript rows.
                        const rows = new Map([[observed.id, observed]]);
                        const reloaded = await fixture.reader.getMessages(fixture.agent.id);
                        for (const row of reloaded.runs.flatMap((run) => run.messages))
                            rows.set(row.id, row);
                        const errors = [...rows.values()].filter(
                            (row) =>
                                row.role === "service" &&
                                row.content.some(
                                    (block) =>
                                        block.type === "text" && block.text.includes(writerText),
                                ) &&
                                row.id !== firstFailure?.id,
                        );
                        expect.soft(errors).toHaveLength(1);
                        expect.soft(errors.map((row) => row.id)).toEqual([failure.id]);
                    } else if (surface === "replay") {
                        const replay = await fixture.stream(fixture.reader, before);
                        const event = await replay.message(emittedId);
                        expect(event.cursor).toBe(sourceEvent!.cursor);
                        observed = event.payload.message;
                    } else {
                        // Projection of the real writer's payload on the pending path;
                        // writer proof is the history/live/replay cells. The synchronous
                        // hello/replay window cannot await inference.
                        const beforePending = fixture.journal.cursor();
                        let pendingCursor: string | undefined;
                        const captured = structuredClone(sourceEvent!.payload);
                        fixture.atHello(() => {
                            const injected = fixture.journal.append(
                                "message.updated",
                                sourceEvent!.payload,
                            );
                            expect(injected.payload).toEqual(captured);
                            pendingCursor = injected.cursor;
                        });
                        const pending = await fixture.stream(fixture.reader, beforePending);
                        const following = fixture.journal.append(
                            "message.updated",
                            sourceEvent!.payload,
                        );
                        expect(following.payload).toEqual(captured);
                        const event = await pending.message(emittedId, "message.updated");
                        expect(event.cursor).toBe(pendingCursor);
                        expect(event.cursor > pending.hello.cursor).toBe(true);
                        expect(event.cursor < following.cursor).toBe(true);
                        observed = event.payload.message;
                        check(
                            (await pending.message(emittedId, "message.updated")).payload.message,
                            authority === "owner",
                        );
                    }
                    check(observed, authority === "owner");
                    const pull = await fixture.reader.getEvents({ after: before });
                    const pulled = pull.events.find(
                        (event) => event.cursor === sourceEvent!.cursor,
                    );
                    expect(pulled?.cursor).toBe(sourceEvent!.cursor);
                    if (pulled?.type === "message.created")
                        check(pulled.payload.message, authority === "owner");
                    expect(
                        await fixture.runtime.modules.history.message(
                            fixture.ctx,
                            fixture.agent.id,
                            failure.id,
                        ),
                    ).toEqual(original);
                    expect.soft(canonical).toMatchObject({
                        error: {
                            credentialSource: {
                                kind: "configuration",
                                location: "providers.private_account.api_key",
                                host: "Private writer host",
                            },
                        },
                    });
                    if (restartLive !== undefined) {
                        // Base follow-up #9 currently adds an unsolicited inference before the new
                        // user's message is accepted. Its rows and events are disclosure surfaces too.
                        const page = await fixture.reader.getMessages(fixture.agent.id);
                        const userRun = page.runs.find((run) => run.id === canonical!.runId);
                        const errors = (message: Message) =>
                            message.role === "service" &&
                            message.content.some(
                                (block) => block.type === "text" && block.text.includes(writerText),
                            );
                        expect.soft(userRun?.messages.filter(errors)).toHaveLength(1);
                        const allErrors = page.runs.flatMap((run) => run.messages).filter(errors);
                        // API-visible error rows grow only by the accepted user's new failure.
                        // Base follow-up #9 already stores an orphan raw error with no visible run;
                        // observation capture must not make that existing orphan API-visible.
                        expect.soft(allErrors).toHaveLength(priorErrorRows + 1);
                        const rawAfter = await fixture.runtime.modules.history.read(
                            fixture.ctx,
                            fixture.agent.id,
                            { limit: 100 },
                        );
                        expect(rawBefore!.messages).toHaveLength(rawBefore!.totalMessages);
                        expect(rawAfter.messages).toHaveLength(rawAfter.totalMessages);
                        expect(failedInferences).toBeGreaterThan(0);
                        // Exact storage growth follows actual failed inferences, independently of
                        // whether Base follow-up #9 adds its extra inference or has been fixed.
                        expect
                            .soft(
                                rawAfter.messages.filter((row) => row.message.role === "error")
                                    .length -
                                    rawBefore!.messages.filter(
                                        (row) => row.message.role === "error",
                                    ).length,
                            )
                            .toBe(failedInferences);
                        expect
                            .soft(
                                rawAfter.messages.flatMap((row) =>
                                    row.message.blocks.filter(
                                        (block) => block.type === "configuration",
                                    ),
                                ),
                            )
                            .toHaveLength(1);
                        for (const row of allErrors) check(row, authority === "owner");
                        if (authority !== "owner")
                            for (const row of page.runs.flatMap((run) => run.messages))
                                checkWithheld(row);
                        const replay = await fixture.reader.getEvents({ after: before });
                        const journalConfigurationIds = new Set(
                            replay.events.flatMap((event) =>
                                (event.type === "message.created" ||
                                    event.type === "message.updated") &&
                                event.payload.agentId === fixture.agent.id &&
                                event.payload.message.content.some(
                                    (block) => block.type === "configuration",
                                )
                                    ? [event.payload.message.id]
                                    : [],
                            ),
                        );
                        const addedVisibleConfigurationIds = new Set(
                            page.runs
                                .flatMap((run) => run.messages)
                                .filter(
                                    (message) =>
                                        message.content.some(
                                            (block) => block.type === "configuration",
                                        ) && !visibleConfigurationIdsBefore.has(message.id),
                                )
                                .map((message) => message.id),
                        );
                        // Count updates only once per message, and require the same identities:
                        // no orphan configuration record may leak into events without visible history.
                        expect
                            .soft(journalConfigurationIds.size)
                            .toBe(addedVisibleConfigurationIds.size);
                        expect.soft(journalConfigurationIds).toEqual(addedVisibleConfigurationIds);
                        for (const event of replay.events) {
                            if (
                                event.type !== "message.created" &&
                                event.type !== "message.updated"
                            )
                                continue;
                            if (errors(event.payload.message))
                                check(event.payload.message, authority === "owner");
                            if (authority !== "owner") checkWithheld(event.payload.message);
                            const streamed = await restartLive.message(
                                event.payload.message.id,
                                event.type,
                            );
                            expect.soft(streamed.payload).toEqual(event.payload);
                            if (errors(streamed.payload.message))
                                check(streamed.payload.message, authority === "owner");
                            if (authority !== "owner") checkWithheld(streamed.payload.message);
                        }
                        // The extra Base inference must not introduce a duplicate configuration baseline.
                        expect
                            .soft(
                                page.runs
                                    .flatMap((run) => run.messages)
                                    .flatMap((row) =>
                                        row.content.filter(
                                            (block) => block.type === "configuration",
                                        ),
                                    ),
                            )
                            .toHaveLength(1);
                    }
                } finally {
                    stopCounting?.();
                    await fixture.close();
                }
            },
            30_000,
        );
    });
});

async function fail(
    fixture: Awaited<ReturnType<typeof credentialWriterRuntime>>,
    previous?: string,
): Promise<Message> {
    const events: AgentEvent[] = [];
    const publicBefore = (await fixture.owner.getEvents()).latestCursor;
    const unsubscribe = fixture.runtime.modules.events.subscribe((event) => {
        if (event.agentId === fixture.agent.id) events.push(event);
    });
    try {
        const submitted = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Exercise the genuine credential writer.",
            mode: writerMode,
        });
        let acceptedRunId: string | undefined;
        await vi.waitFor(
            async () => {
                const acceptance = (
                    await fixture.owner.getEvents({ after: publicBefore })
                ).events.find(
                    (event) =>
                        (event.type === "run.started" || event.type === "run.boundary") &&
                        event.payload.acceptedMessageIds.includes(submitted.message.id),
                );
                if (acceptance?.type === "run.started") acceptedRunId = acceptance.payload.run.id;
                if (acceptance?.type === "run.boundary")
                    acceptedRunId = acceptance.payload.startedRun.id;
                expect(acceptedRunId).toBeDefined();
            },
            { timeout: 10_000, interval: 10 },
        );
        let message: Message | undefined;
        await vi.waitFor(
            async () => {
                const history = await fixture.reader.getMessages(fixture.agent.id);
                message = history.runs
                    .filter((run) => run.status === "failed" && run.id === acceptedRunId)
                    .flatMap((run) => run.messages)
                    .findLast(
                        (entry) =>
                            entry.id !== previous &&
                            entry.role === "service" &&
                            entry.content.some(
                                (block) => block.type === "text" && block.text.includes(writerText),
                            ),
                    );
                expect(message).toBeDefined();
            },
            { timeout: 10_000, interval: 10 },
        );
        // API.md:8959-8963: run.finished is terminal with no immediate successor, and the agent is idle.
        await vi.waitFor(
            async () =>
                expect(
                    (await fixture.owner.getEvents({ after: publicBefore })).events.some(
                        (event) =>
                            event.type === "run.finished" && event.payload.run.id === acceptedRunId,
                    ),
                ).toBe(true),
            { timeout: 10_000, interval: 10 },
        );
        await vi.waitFor(
            async () =>
                expect((await fixture.owner.getAgent(fixture.agent.id)).agent.status).toBe("idle"),
            { timeout: 10_000, interval: 10 },
        );
        const configurations = (await fixture.reader.getMessages(fixture.agent.id)).runs
            .flatMap((run) => run.messages)
            .flatMap((row) => row.content.filter((block) => block.type === "configuration"));
        expect.soft(configurations).toHaveLength(1);
        expect.soft(configurations[0]).toMatchObject({
            type: "configuration",
            before: null,
            after: { ...writerMode, providerType: "codex", account: null },
            ...(previous === undefined ? { beforeMessageId: submitted.message.id } : {}),
        });
        expect(
            events.findLast(
                (event) =>
                    event.type === "provider.event" &&
                    (event.payload as { event?: { type?: string } }).event?.type === "done",
            )?.payload,
        ).toMatchObject({
            event: {
                type: "done",
                state: "error",
                providerError: { type: "authentication", diagnostics: { status: 401 } },
            },
        });
        return message!;
    } finally {
        unsubscribe();
    }
}

function check(message: Message, disclose: boolean) {
    expect.soft(message).toMatchObject({
        role: "service",
        error: {
            code: "authentication_failed",
            mode: { ...writerMode, providerType: "codex", account: null },
            credentialSource: disclose
                ? {
                      kind: "configuration",
                      location: "providers.private_account.api_key",
                      host: "Private writer host",
                  }
                : null,
            recovery: { actions: ["ask_chief"] },
        },
    });
    expect
        .soft(
            message.content.some(
                (block) => block.type === "text" && block.text.includes(writerText),
            ),
        )
        .toBe(true);
    const prose = JSON.stringify(message.content);
    for (const marker of [
        "providers.private_account.api_key",
        "Private writer host",
        "synthetic-writer-key",
    ])
        expect.soft(prose).not.toContain(marker);
    if (!disclose) {
        expect.soft(message).not.toHaveProperty("error.recovery.commands");
        for (const marker of [
            "providers.private_account.api_key",
            "Private writer host",
            "synthetic-writer-key",
        ])
            expect.soft(JSON.stringify(message)).not.toContain(marker);
    }
}

function checkWithheld(message: Message) {
    for (const marker of [
        "providers.private_account.api_key",
        "Private writer host",
        "synthetic-writer-key",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "GROK_HOME",
    ])
        expect.soft(JSON.stringify(message)).not.toContain(marker);
    if (message.role === "service" && message.error !== undefined) {
        expect.soft(message.error.credentialSource).toBeNull();
        expect.soft(message.error.recovery).not.toHaveProperty("commands");
    }
}
