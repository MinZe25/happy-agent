import type { HappyAgentEvent, Message } from "@slopus/happy-agent-client";
import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

it("reserves A's configuration before its queued conversion can observe the later B attempt", async () => {
    const gate = deferred();
    let gateEntered = false;
    let released = false;
    let bStarted = false;
    let executionSettled = false;
    let aBlockBeforeB = false;
    let aCalls = 0;
    const attempts: string[] = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
    const provider: BaseProvider = CodexProvider.prototype;
    vi.spyOn(provider, "session").mockImplementation(
        async function (this: CodexProvider, id, options) {
            const selected = this.endpoint.endsWith("/other") ? "other_account" : "private_account";
            const session = new ScriptedSession(id, [], options);
            vi.spyOn(session, "run").mockImplementation(() =>
                (async function* () {
                    if (id.startsWith("naming:")) {
                        yield done();
                        return;
                    }
                    attempts.push(selected);
                    if (selected === "other_account") {
                        bStarted = true;
                        yield* text("B output.");
                        yield {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: "Synthetic terminal B authentication failure.",
                            providerError: { type: "authentication" },
                        } as SessionEvent;
                        return;
                    }
                    if (++aCalls === 2) {
                        yield {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: "Synthetic first account authentication failure.",
                            providerError: { type: "authentication" },
                        } as SessionEvent;
                        return;
                    }
                    yield* text("A output.");
                    yield { type: "block_start" } as SessionEvent;
                    yield {
                        type: "toolcall_start",
                        callId: "queued-route-probe",
                        name: "list_skills",
                    } as SessionEvent;
                    yield {
                        type: "toolcall_end",
                        callId: "queued-route-probe",
                        arguments: "{}",
                    } as SessionEvent;
                    yield { type: "block_stop" } as SessionEvent;
                    yield {
                        type: "done",
                        state: "tool_call",
                        tokens: { input: 0, output: 0 },
                    } as SessionEvent;
                })(),
            );
            return session;
        },
    );
    const fixture = await credentialWriterRuntime("owner", {
        providerConfiguration: `[providers]
default_enable = false
[providers.private_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-a-key"
base_url = "http://127.0.0.1:1/first"
[providers.other_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-b-key"
base_url = "http://127.0.0.1:1/other"
[providers.router]
type = "smart"
enabled = true
providers = ["private_account", "other_account"]
`,
    });
    const events = fixture.runtime.modules.events;
    const previousCursor = events.previousCursor.bind(events);
    // Race gate: accepted-message conversion and block_start share ApiModule's per-agent
    // #enqueueAgentEvent Promise chain. Hold the former while both provider attempts advance.
    const held = vi.spyOn(events, "previousCursor").mockImplementation(async (...args) => {
        if (args[1] === fixture.agent.id && !gateEntered) {
            gateEntered = true;
            await gate.promise;
        }
        return await previousCursor(...args);
    });
    const stop = events.subscribe((event) => {
        if (event.agentId === fixture.agent.id && event.type === "loop.settled")
            executionSettled = true;
        if (
            event.agentId === fixture.agent.id &&
            event.type === "provider.event" &&
            JSON.stringify(event.payload).includes('"type":"block_start"') &&
            !bStarted
        )
            aBlockBeforeB = true;
    });
    try {
        const before = fixture.journal.cursor();
        const sending = fixture.owner.sendMessage(fixture.agent.id, {
            text: "Hold delivery while routing changes.",
            mode: { ...writerMode, providerId: "router" },
        });
        await vi.waitFor(() => expect(gateEntered && bStarted && executionSettled).toBe(true), {
            timeout: 10_000,
            interval: 10,
        });
        expect(aBlockBeforeB).toBe(true);
        expect(created(before).filter((message) => message.role === "agent")).toEqual([]);
        // Neither a configuration nor error append may overtake queued stream conversion.
        const checkpoint = fixture.journal.replay(before, undefined, 10_000)?.events ?? [];
        const messageEvents = checkpoint.filter((raw) => {
            const event = raw as HappyAgentEvent;
            return (
                (event.type === "message.created" ||
                    event.type === "message.updated" ||
                    event.type === "message.deleted") &&
                event.payload.agentId === fixture.agent.id
            );
        });
        expect.soft(messageEvents).toHaveLength(1);
        expect
            .soft(messageEvents[0])
            .toMatchObject({ type: "message.created", payload: { message: { role: "user" } } });
        console.info(
            "Race checkpoint non-message event types (unasserted)",
            checkpoint
                .filter(
                    (event) =>
                        !["message.created", "message.updated", "message.deleted"].includes(
                            event.type,
                        ),
                )
                .map((event) => event.type),
        );
        expect(released).toBe(false);
        released = true;
        gate.resolve();
        const sent = await sending;
        await vi.waitFor(
            async () => {
                const page = await fixture.owner.getMessages(fixture.agent.id);
                expect(page.runs[0]?.status).toBe("failed");
                expect(
                    (await fixture.owner.getEvents({ after: before })).events.some(
                        (event) => event.type === "run.finished",
                    ),
                ).toBe(true);
            },
            { timeout: 10_000, interval: 10 },
        );
        expect(attempts).toEqual(["private_account", "private_account", "other_account"]);
        const messages = (await fixture.owner.getMessages(fixture.agent.id)).runs.flatMap(
            (run) => run.messages,
        );
        const live = created(before);
        const configurations = messages.filter((message) =>
            message.content.some((block) => block.type === "configuration"),
        );
        expect.soft(configurations).toHaveLength(2);
        const blocks = configurations.flatMap((message) =>
            message.content.filter((block) => block.type === "configuration"),
        );
        expect.soft(blocks[0]).toMatchObject({
            before: null,
            beforeMessageId: sent.message.id,
            after: { providerId: "private_account" },
        });
        expect.soft(blocks[1]).toMatchObject({
            before: { providerId: "private_account" },
            beforeMessageId: null,
            after: { providerId: "other_account" },
        });
        expect
            .soft(live.map((message) => message.id))
            .toEqual(messages.map((message) => message.id));
        expect
            .soft(live.filter((message) => configurations.some((row) => row.id === message.id)))
            .toEqual(configurations);
        expect(new Set(live.map((message) => message.id)).size).toBe(live.length);
        expect.soft(messages.at(-1)).toMatchObject({
            role: "service",
            error: {
                code: "authentication_failed",
                mode: { providerId: "other_account" },
                credentialSource: {
                    kind: "configuration",
                    location: "providers.other_account.api_key",
                },
            },
        });
        expect.soft(live.at(-1)).toEqual(messages.at(-1));
        for (const [index, content] of ["A output.", "B output."].entries()) {
            const output = messages.find((message) =>
                message.content.some((block) => block.type === "text" && block.text === content),
            );
            expect(output).toBeDefined();
            const rowIndex = live.findIndex((message) => message.id === configurations[index]?.id);
            expect.soft(rowIndex).toBeGreaterThanOrEqual(0);
            expect.soft(live.findIndex((message) => message.id === output?.id)).toBe(rowIndex + 1);
        }
    } finally {
        gate.resolve();
        held.mockRestore();
        stop();
        await fixture.close();
        vi.restoreAllMocks();
    }

    function created(after: string): Message[] {
        return (fixture.journal.replay(after, undefined, 10_000)?.events ?? []).flatMap((raw) => {
            const event = raw as HappyAgentEvent;
            return event.type === "message.created" && event.payload.agentId === fixture.agent.id
                ? [event.payload.message]
                : [];
        });
    }
}, 30_000);

function* text(value: string): Generator<SessionEvent> {
    yield { type: "block_start" };
    yield { type: "text_start" };
    yield { type: "text_delta", delta: value };
    yield { type: "text_end" };
    yield { type: "block_stop" };
}

function done(): SessionEvent {
    return { type: "done", state: "normal", tokens: { input: 0, output: 0 } };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
