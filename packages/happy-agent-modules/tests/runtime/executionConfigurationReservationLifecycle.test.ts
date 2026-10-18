import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

it.each(["settlement", "abort", "reservation error"] as const)(
    "releases an actually prepared inference after real %s",
    async (ending) => {
        const specifier = "../../sources/history/impl/ExecutionConfigurationReservations.js";
        const implementation = await import(specifier).catch(() => undefined);
        expect(
            implementation?.ExecutionConfigurationReservations,
            "the bounded reservation operation exists",
        ).toBeTypeOf("function");
        const prototype = implementation.ExecutionConfigurationReservations.prototype;
        const prepare = prototype.prepare;
        const stores = new Set<{ readonly size: number }>();
        let preparedSize = 0;
        vi.spyOn(prototype, "prepare").mockImplementation(function (
            this: { readonly size: number },
            ...args: unknown[]
        ) {
            const result = prepare.apply(this, args);
            stores.add(this);
            preparedSize = Math.max(preparedSize, this.size);
            return result;
        });
        let entered = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const provider: BaseProvider = CodexProvider.prototype;
        vi.spyOn(provider, "session").mockImplementation(async function (id, options) {
            const session = new ScriptedSession(id, [], options);
            vi.spyOn(session, "run").mockImplementation(() =>
                (async function* () {
                    if (!id.startsWith("naming:")) {
                        entered = true;
                        if (ending === "abort") await gate;
                        yield { type: "block_start" } as SessionEvent;
                        yield { type: "text_start" } as SessionEvent;
                        yield {
                            type: "text_delta",
                            delta: "Complete the prepared operation.",
                        } as SessionEvent;
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
            if (ending === "reservation error") {
                vi.spyOn(
                    fixture.runtime.modules.config,
                    "currentExecutionObservation",
                ).mockImplementation(() => {
                    throw new Error("Synthetic reservation snapshot failure.");
                });
            }
            const before = (await fixture.owner.getEvents()).latestCursor;
            const sent = await fixture.owner.sendMessage(fixture.agent.id, {
                text: "Exercise prepared lifetime.",
                mode: writerMode,
            });
            await vi.waitFor(() => expect(entered).toBe(true));
            expect(stores.size).toBe(1);
            expect(preparedSize).toBe(1);
            if (ending === "abort") await fixture.owner.abortAgent(fixture.agent.id);
            await vi.waitFor(
                async () => {
                    const run = (await fixture.owner.getMessages(fixture.agent.id)).runs.find(
                        (run) => run.messages.some((message) => message.id === sent.message.id),
                    );
                    expect(run?.status).toBe(ending === "abort" ? "aborted" : "completed");
                    expect((await fixture.owner.getAgent(fixture.agent.id)).agent.status).toBe(
                        "idle",
                    );
                    expect(
                        (await fixture.owner.getEvents({ after: before })).events.some(
                            (event) => event.type === "run.finished",
                        ),
                    ).toBe(true);
                    for (const store of stores) expect(store.size).toBe(0);
                },
                { timeout: 10_000, interval: 10 },
            );
            if (ending === "reservation error") {
                const messages = (await fixture.owner.getMessages(fixture.agent.id)).runs.flatMap(
                    (run) => run.messages,
                );
                const events = (await fixture.owner.getEvents({ after: before })).events;
                const created = events.flatMap((event) =>
                    event.type === "message.created" && event.payload.agentId === fixture.agent.id
                        ? [event.payload.message]
                        : [],
                );
                expect(
                    messages.flatMap((message) =>
                        message.content.filter((block) => block.type === "configuration"),
                    ),
                ).toEqual([]);
                expect(
                    created.flatMap((message) =>
                        message.content.filter((block) => block.type === "configuration"),
                    ),
                ).toEqual([]);
                expect(created.map((message) => message.id)).toEqual(
                    messages.map((message) => message.id),
                );
            }
        } finally {
            release();
            await fixture.close();
            vi.restoreAllMocks();
        }
    },
    30_000,
);
