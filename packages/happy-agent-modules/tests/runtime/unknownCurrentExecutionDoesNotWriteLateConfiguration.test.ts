import type { Message } from "@slopus/happy-agent-client";
import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

it("never backfills a configuration after an unknown live attempt and keeps the next observed baseline", async () => {
    type Store = {
        read(
            agentId: string,
            operationId: string,
        ): readonly { mode: { providerId: string } }[] | undefined;
    };
    const completed: Array<{
        agentId: string;
        operationId: string;
        attempts: ReturnType<Store["read"]>;
    }> = [];
    // This internal seam is intentionally unavailable on the pre-writer control revision.
    const specifier = "../../sources/config/impl/ProviderExecutionObservations.js";
    const module = await import(specifier).catch(() => undefined);
    const prototype = module?.ProviderExecutionObservations?.prototype;
    let restoreCurrent = () => {};
    let currentCalls = 0;
    if (prototype !== undefined) {
        const end = prototype.end;
        vi.spyOn(prototype, "end").mockImplementation(function (this: Store, ...args: unknown[]) {
            const agentId = args[0] as string;
            const operationId = args[1] as string;
            completed.push({
                agentId,
                operationId,
                attempts: this.read(agentId, operationId),
            });
            return end.apply(this, args);
        });
        if (typeof prototype.current === "function") {
            const current = vi.spyOn(prototype, "current").mockImplementation(() => {
                currentCalls += 1;
                return undefined;
            });
            restoreCurrent = () => current.mockRestore();
        }
    }
    const providerPrototype: BaseProvider = CodexProvider.prototype;
    vi.spyOn(providerPrototype, "session").mockImplementation(async function (id, options) {
        const session = new ScriptedSession(id, [], options);
        vi.spyOn(session, "run").mockImplementation(() =>
            (async function* () {
                if (!id.startsWith("naming:")) {
                    yield { type: "block_start" } as SessionEvent;
                    yield { type: "text_start" } as SessionEvent;
                    yield { type: "text_delta", delta: "Observed output." } as SessionEvent;
                    yield { type: "text_end" } as SessionEvent;
                    yield { type: "block_stop" } as SessionEvent;
                }
                yield {
                    type: "done",
                    state: "normal",
                    tokens: { input: 0, output: 0 },
                } as SessionEvent;
            })(),
        );
        return session;
    });
    const fixture = await credentialWriterRuntime("owner");
    try {
        const before = (await fixture.owner.getEvents()).latestCursor;
        const first = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Unknown live observation.",
            mode: writerMode,
        });
        const firstRun = await settled(first.message.id);
        const firstCreated = await created(before);
        // The finalized observation remains valid: only its live/current lookup was withheld.
        expect.soft(currentCalls).toBeGreaterThan(0);
        const observed = completed.filter(
            (entry) => entry.agentId === fixture.agent.id && entry.attempts !== undefined,
        );
        expect.soft(observed).toHaveLength(1);
        expect.soft(observed[0]?.operationId ?? "").toMatch(/\S/);
        expect
            .soft(observed[0]?.attempts)
            .toMatchObject([{ mode: { providerId: "private_account" } }]);
        expect.soft(configurations(firstRun.messages)).toEqual([]);
        expect.soft(configurations(firstCreated)).toEqual([]);
        expect
            .soft(firstCreated.map((message) => message.id))
            .toEqual(firstRun.messages.map((message) => message.id));
        expect(
            firstRun.messages.some(
                (message) =>
                    message.role === "agent" &&
                    message.content.some(
                        (block) => block.type === "text" && block.text === "Observed output.",
                    ),
            ),
        ).toBe(true);

        restoreCurrent();
        const after = (await fixture.owner.getEvents()).latestCursor;
        const second = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Known live observation.",
            mode: writerMode,
        });
        const secondRun = await settled(second.message.id);
        const secondCreated = await created(after);
        const records = configurations(secondRun.messages);
        expect.soft(records).toHaveLength(1);
        expect.soft(records[0]?.content).toEqual([
            {
                type: "configuration",
                before: null,
                after: { ...writerMode, providerType: "codex", account: null },
                beforeMessageId: second.message.id,
            },
        ]);
        expect.soft(configurations(secondCreated)).toEqual(records);
        expect
            .soft(secondCreated.map((message) => message.id))
            .toEqual(secondRun.messages.map((message) => message.id));
        const configurationIndex = secondCreated.findIndex(
            (message) => message.id === records[0]?.id,
        );
        const outputIndex = secondCreated.findIndex((message) => message.role === "agent");
        expect.soft(configurationIndex).toBeGreaterThanOrEqual(0);
        expect.soft(outputIndex).toBe(configurationIndex + 1);
    } finally {
        restoreCurrent();
        await fixture.close();
        vi.restoreAllMocks();
    }

    async function settled(messageId: string) {
        let run: Awaited<ReturnType<typeof fixture.owner.getMessages>>["runs"][number] | undefined;
        await vi.waitFor(
            async () => {
                run = (await fixture.owner.getMessages(fixture.agent.id)).runs.find((candidate) =>
                    candidate.messages.some((message) => message.id === messageId),
                );
                expect(run?.status).toBe("completed");
                expect(
                    (await fixture.owner.getEvents()).events.some(
                        (event) =>
                            event.type === "run.finished" && event.payload.run.id === run?.id,
                    ),
                ).toBe(true);
                expect((await fixture.owner.getAgent(fixture.agent.id)).agent.status).toBe("idle");
            },
            { timeout: 10_000, interval: 10 },
        );
        return run!;
    }

    async function created(after: string) {
        return (await fixture.owner.getEvents({ after })).events.flatMap((event) =>
            event.type === "message.created" && event.payload.agentId === fixture.agent.id
                ? [event.payload.message]
                : [],
        );
    }
}, 30_000);

function configurations(messages: readonly Message[]) {
    return messages.filter((message) =>
        message.content.some((block) => block.type === "configuration"),
    );
}
