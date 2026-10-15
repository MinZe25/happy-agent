import type { AgentModuleScope, AgentModuleSystemScope } from "@slopus/happy-agent-base";
import { GracefulShutdown, withLifetime, withShutdown, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SchedulingEventListener } from "../../sources/scheduling/SchedulingEvent.js";
import {
    advance,
    armedAlarms,
    schedulingHarness,
    settle,
    START_TIME,
    TestAgents,
    useSchedulingClock,
    type SchedulingHarness,
} from "./support/schedulingHarness.js";

const agentId = "agenta";

describe("Scheduling waits", () => {
    beforeEach(() => {
        useSchedulingClock();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("projects the earliest concurrent interval and announces only changes to that interval", async () => {
        const harness = await schedulingHarness("wait-current-interval");
        const intervals: unknown[] = [];
        harness.module.onEventTransactional((_ctx, event) => {
            if (
                (event.type === "wait_started" || event.type === "wait_finished") &&
                event.activeWait !== undefined
            )
                intervals.push(event.activeWait);
        });
        try {
            const ten = harness.module.wait(harness.database.context, agentId, {
                id: "waitten",
                duration: { seconds: 10 },
            });
            await settle();
            const five = harness.module.wait(harness.database.context, agentId, {
                id: "waitfive",
                duration: { seconds: 5 },
            });
            await settle();
            const fifteen = harness.module.wait(harness.database.context, agentId, {
                id: "waitfifteen",
                duration: { seconds: 15 },
            });
            await settle();
            const interval = (seconds: number) => ({
                startedAt: START_TIME,
                dueAt: START_TIME + seconds * 1_000,
            });
            expect(await harness.module.readActiveWait(harness.database.context, agentId)).toEqual(
                interval(5),
            );
            expect(intervals).toEqual([interval(10), interval(5)]);
            await advance(5_000);
            await five;
            expect(await harness.module.readActiveWait(harness.database.context, agentId)).toEqual(
                interval(10),
            );
            await advance(5_000);
            await ten;
            expect(await harness.module.readActiveWait(harness.database.context, agentId)).toEqual(
                interval(15),
            );
            await advance(5_000);
            await fifteen;
            expect(
                await harness.module.readActiveWait(harness.database.context, agentId),
            ).toBeNull();
            expect(intervals).toEqual([
                interval(10),
                interval(5),
                interval(10),
                interval(15),
                null,
            ]);
            await harness.module.wait(harness.database.context, agentId, {
                id: "waitfive",
                duration: { seconds: 5 },
            });
            expect(intervals).toHaveLength(5);
        } finally {
            harness.close();
        }
    });

    it("finishes a wait when its own time comes and reports what really elapsed", async () => {
        const harness = await schedulingHarness("wait-elapses");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waitone",
                duration: { seconds: 90 },
            });
            await settle();
            expect(armedAlarms()).toBe(1);

            await advance(90_000);
            const result = await pending;

            expect(result).toMatchObject({
                waitId: "waitone",
                agentId,
                outcome: "elapsed",
                kind: "wait",
                elapsedMs: 90_000,
            });
            expect(harness.module.formatWaitForModel(result)).toBe(
                "The wait finished after 1.5 minutes.",
            );
        } finally {
            harness.close();
        }
    });

    it("accepts a duration written the way a person says it", async () => {
        const harness = await schedulingHarness("wait-duration-text");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waittwo",
                duration: "1h 30m",
            });
            await settle();
            await advance(90 * 60_000);

            expect((await pending).elapsedMs).toBe(5_400_000);
        } finally {
            harness.close();
        }
    });

    it("refuses a wait longer than a day", async () => {
        const harness = await schedulingHarness("wait-too-long");
        try {
            await expect(
                harness.module.wait(harness.database.context, agentId, {
                    id: "waitlong",
                    duration: { days: 2 },
                }),
            ).rejects.toThrow("longer than the 1 day limit");
        } finally {
            harness.close();
        }
    });

    it("waits until a date and returns at once for a date already past", async () => {
        const harness = await schedulingHarness("wait-until");
        try {
            const pending = harness.module.waitUntil(harness.database.context, agentId, {
                id: "waituntil",
                at: new Date(Date.now() + 60_000).toISOString(),
            });
            await settle();
            await advance(60_000);
            expect((await pending).outcome).toBe("elapsed");

            const past = await harness.module.waitUntil(harness.database.context, agentId, {
                id: "waitpast",
                at: 1,
            });
            expect(past).toMatchObject({ outcome: "elapsed", elapsedMs: 0 });
        } finally {
            harness.close();
        }
    });

    it("ends a wait early when a message is written into the chat", async () => {
        const harness = await schedulingHarness("wait-interrupted");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waitmsg",
                duration: { hours: 2 },
            });
            await settle();

            await advance(42_000);
            harness.module.interruptWaits(harness.database.context, agentId);
            const result = await pending;

            expect(result).toMatchObject({ outcome: "interrupted", elapsedMs: 42_000 });
            expect(harness.module.formatWaitForModel(result)).toBe(
                "The wait ended early because a new message arrived after 42 seconds.",
            );
        } finally {
            harness.close();
        }
    });

    it("ends a wait when the agent takes a message into its conversation", async () => {
        const harness = await schedulingHarness("wait-message-accepted");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waithook",
                duration: { hours: 1 },
            });
            await settle();

            await advance(1_000);
            await harness.hooks.messageAccepted?.(
                harness.database.context,
                { agent: { id: agentId } } as AgentModuleScope,
                {} as never,
            );

            expect((await pending).outcome).toBe("interrupted");
        } finally {
            harness.close();
        }
    });

    it("ends a wait when the turn holding it is aborted", async () => {
        const harness = await schedulingHarness("wait-aborted");
        try {
            const turn = new AbortController();
            const turnCtx = Object.create(harness.database.context, {
                lifetime: { value: turn.signal },
            }) as typeof harness.database.context;
            const pending = harness.module.wait(turnCtx, agentId, {
                id: "waitabort",
                duration: { hours: 3 },
            });
            await settle();

            await advance(5_000);
            turn.abort();

            expect(await pending).toMatchObject({ outcome: "interrupted", elapsedMs: 5_000 });
        } finally {
            harness.close();
        }
    });

    it("re-enters its own durable wait after a restart and finishes it once", async () => {
        const first = await schedulingHarness("wait-restart");
        try {
            // The process dies here: the row is written and this tool call never returns to
            // anyone. The durable row is all that survives, and the restarted module re-enters it.
            const abandoned = first.module.wait(first.database.context, agentId, {
                id: "waitagain",
                duration: { hours: 1 },
            });
            void abandoned.catch(() => undefined);
            await settle();

            const second = await schedulingHarness("wait-restart", {
                database: first.database,
            });
            const resumed = second.module.wait(second.database.context, agentId, {
                id: "waitagain",
                duration: { hours: 1 },
            });
            await settle();
            await advance(60 * 60_000);
            const result = await resumed;

            // Elapsed is measured from the original start, not from the restart.
            expect(result).toMatchObject({ outcome: "elapsed", startedAt: START_TIME });
            expect(result.elapsedMs).toBe(60 * 60_000);
        } finally {
            first.close();
        }
    });

    it("settles a wait a steering message interrupts, even though the call's own context has ended", async () => {
        const intervals: unknown[] = [];
        const record = recordIntervals(intervals);
        const harness = await schedulingHarness("wait-steered", {
            // The API records each interval change in agent storage, which refuses a context
            // whose work has ended.
            listener: async (ctx, event) => {
                if (ctx.lifetime?.aborted === true) {
                    throw new Error(
                        "The store cannot be used: the work its context belongs to has ended.",
                    );
                }
                await record(ctx, event);
            },
        });
        try {
            const turn = new AbortController();
            const turnCtx = withLifetime(harness.database.context, turn.signal);
            const pending = harness.module.wait(turnCtx, agentId, {
                id: "waitsteered",
                duration: { minutes: 30 },
            });
            await settle();
            await advance(5_000);

            // Steering aborts the run, which ends the lifetime of the call holding the wait.
            turn.abort();

            expect(await pending).toMatchObject({ outcome: "interrupted", elapsedMs: 5_000 });
            expect(
                await harness.module.readActiveWait(harness.database.context, agentId),
            ).toBeNull();
            expect(intervals).toEqual([
                { startedAt: START_TIME, dueAt: START_TIME + 1_800_000 },
                null,
            ]);
        } finally {
            harness.close();
        }
    });

    it("stops reporting a wait once its call is answered, even when shutdown left the row waiting", async () => {
        const intervals: unknown[] = [];
        const harness = await schedulingHarness("wait-answered-during-shutdown", {
            listener: recordIntervals(intervals),
        });
        try {
            const daemon = daemonProcess(harness.database.context);
            const pending = harness.module.wait(daemon.ctx, agentId, {
                id: "waitorphan",
                duration: { minutes: 5 },
            });
            void pending.catch(() => undefined);
            await settle();
            const interval = { startedAt: START_TIME, dueAt: START_TIME + 5 * 60_000 };
            expect(await harness.module.readActiveWait(harness.database.context, agentId)).toEqual(
                interval,
            );

            // Shutdown ends every context of the process before the agent's reload edge, so the
            // wait leaves its row for replay, and Agent Base can still commit what it threw as
            // the call's answer. The agent then moves on without that call ever running again.
            await advance(1_000);
            daemon.shutDown();
            await expect(pending).rejects.toThrow("suspended while the daemon restarts");
            await answerCall(harness, "waitorphan");

            expect(
                await harness.module.readActiveWait(harness.database.context, agentId),
            ).toBeNull();
            expect(intervals).toEqual([interval, null]);
        } finally {
            harness.close();
        }
    });

    it("stops reporting a wait the moment an abort answers its call, before the wait wakes", async () => {
        const intervals: unknown[] = [];
        const harness = await schedulingHarness("wait-answered-by-abort", {
            listener: recordIntervals(intervals),
        });
        try {
            const turn = new AbortController();
            const turnCtx = Object.create(harness.database.context, {
                lifetime: { value: turn.signal },
            }) as typeof harness.database.context;
            const pending = harness.module.wait(turnCtx, agentId, {
                id: "waitabandoned",
                duration: { hours: 1 },
            });
            await settle();
            await advance(2_000);

            // Agent Base commits the aborted answer first and only then cancels the call.
            await answerCall(harness, "waitabandoned");
            expect(
                await harness.module.readActiveWait(harness.database.context, agentId),
            ).toBeNull();
            turn.abort();

            expect(await pending).toMatchObject({ outcome: "interrupted", elapsedMs: 2_000 });
            expect(intervals).toEqual([
                { startedAt: START_TIME, dueAt: START_TIME + 3_600_000 },
                null,
            ]);
        } finally {
            harness.close();
        }
    });

    it("reports a wait left by an earlier process only once its call replays", async () => {
        const first = await schedulingHarness("wait-left-by-restart");
        const intervals: unknown[] = [];
        try {
            const daemon = daemonProcess(first.database.context);
            const replayed = first.module.wait(daemon.ctx, agentId, {
                id: "waitreplayed",
                duration: { hours: 1 },
            });
            await settle();
            const orphaned = first.module.wait(daemon.ctx, "agentb", {
                id: "waitorphaned",
                duration: { minutes: 5 },
            });
            void replayed.catch(() => undefined);
            void orphaned.catch(() => undefined);
            await settle();
            daemon.shutDown();
            await settle();

            const second = await schedulingHarness("wait-left-by-restart", {
                database: first.database,
                listener: recordIntervals(intervals),
            });
            try {
                // The new process restores every agent before any of them runs, so nothing in it
                // holds either wait yet and neither is live.
                await restoreAgent(second, agentId);
                await restoreAgent(second, "agentb");
                expect(
                    await second.module.readActiveWait(second.database.context, agentId),
                ).toBeNull();
                expect(
                    await second.module.readActiveWait(second.database.context, "agentb"),
                ).toBeNull();
                expect(intervals).toEqual([null, null]);

                const resumed = second.module.wait(second.database.context, agentId, {
                    id: "waitreplayed",
                    duration: { hours: 1 },
                });
                await settle();
                const original = { startedAt: START_TIME, dueAt: START_TIME + 3_600_000 };
                expect(
                    await second.module.readActiveWait(second.database.context, agentId),
                ).toEqual(original);
                expect(intervals).toEqual([null, null, original]);

                // The orphan's call was answered in the earlier process and never replays; once
                // its answer is seen, the row is settled rather than left behind.
                await advance(10 * 60_000);
                expect(
                    await second.module.readActiveWait(second.database.context, "agentb"),
                ).toBeNull();
                await answerCall(second, "waitorphaned", "agentb");
                expect(intervals).toEqual([null, null, original]);

                await advance(50 * 60_000);
                expect(await resumed).toMatchObject({
                    outcome: "elapsed",
                    startedAt: START_TIME,
                    elapsedMs: 3_600_000,
                });
                expect(intervals).toEqual([null, null, original, null]);
            } finally {
                second.close();
            }
        } finally {
            first.close();
        }
    });

    it("returns the settled result when the same durable call runs again", async () => {
        const harness = await schedulingHarness("wait-replay");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                id: "waitonce",
                duration: { seconds: 5 },
            });
            await settle();
            await advance(5_000);
            const first = await pending;

            const replayed = await harness.module.wait(harness.database.context, agentId, {
                id: "waitonce",
                duration: { seconds: 5 },
            });

            expect(replayed).toEqual(first);
        } finally {
            harness.close();
        }
    });

    it("mints its own wait identity when a caller does not supply one", async () => {
        const harness = await schedulingHarness("wait-generated-id");
        try {
            const pending = harness.module.wait(harness.database.context, agentId, {
                duration: { seconds: 1 },
            });
            await settle();
            await advance(1_000);

            expect((await pending).waitId).toMatch(/^[a-z][a-z0-9]{1,31}$/);
        } finally {
            harness.close();
        }
    });

    it("gives every agent the two wait tools, and message tools only to agents with no parent", async () => {
        const agents = new TestAgents({ childagent: "agenta" });
        const harness = await schedulingHarness("wait-tools", { agents });
        try {
            const toolsFor = async (id: string) =>
                (await harness.hooks.tools?.(harness.database.context, {
                    agent: { id },
                } as AgentModuleScope)) ?? [];
            const rootTools = await toolsFor(agentId);
            const childTools = await toolsFor("childagent");

            expect(rootTools.map((tool) => tool.name)).toEqual([
                "wait",
                "wait_until",
                "schedule_message",
                "list_scheduled_messages",
                "cancel_scheduled_message",
            ]);
            expect(childTools.map((tool) => tool.name)).toEqual(["wait", "wait_until"]);
            expect(childTools.map((tool) => tool.steerable)).toEqual([true, true]);
            expect(rootTools.filter((tool) => tool.reloadable).map((tool) => tool.name)).toEqual([
                "wait",
                "wait_until",
                "list_scheduled_messages",
            ]);
        } finally {
            harness.close();
        }
    });
});

/** Collect every change to the active interval that scheduling announces. */
function recordIntervals(intervals: unknown[]): SchedulingEventListener {
    return (_ctx, event) => {
        if ("activeWait" in event && event.activeWait !== undefined)
            intervals.push(event.activeWait);
    };
}

/** The context a daemon gives its tool calls: shutdown ends its lifetime before anything else. */
function daemonProcess(ctx: Context): { readonly ctx: Context; readonly shutDown: () => void } {
    const coordinator = new GracefulShutdown();
    return {
        ctx: withShutdown(ctx, coordinator),
        shutDown: () => void coordinator.shutdown(),
    };
}

/** Restore one agent the way the agent system does at start, inside its restoration transaction. */
async function restoreAgent(harness: SchedulingHarness, agent: string): Promise<void> {
    await harness.database.context.inTx(async (txCtx) => {
        await harness.hooks.agentRestoredTransact?.(txCtx, {} as AgentModuleSystemScope, {
            id: agent,
            metadata: undefined,
        });
    });
}

/** Commit an answer to one tool call the way Agent Base does, inside its result transaction. */
async function answerCall(
    harness: SchedulingHarness,
    callId: string,
    agent: string = agentId,
): Promise<void> {
    await harness.database.context.inTx(async (txCtx) => {
        await harness.hooks.afterToolCallTransact?.(
            txCtx,
            { agent: { id: agent } } as AgentModuleScope,
            {
                role: "tool",
                callId,
                content: [{ type: "text", text: "The tool call was aborted." }],
                isError: true,
            },
        );
    });
}
