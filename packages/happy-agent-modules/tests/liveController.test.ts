import { createRootContext } from "@steve.kite/stdlib";
import type { BaseProvider, SessionEvent, SessionOptions } from "@slopus/happy-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    LIVE_CONTROLLER_TOOLS,
    LIVE_MODEL_CHANGE_TOOLS,
    LIVE_TASK_CREATE_TOOLS,
    liveControllerConversation,
    closeLiveController,
    runLiveController,
} from "../sources/live/impl/runLiveController.js";
import type {
    LiveAppState,
    LiveDesktopAction,
    LiveDesktopActionResult,
    LiveDesktopContext,
} from "@slopus/happy-agent-client";

const context: LiveDesktopContext = {
    windowId: "window",
    connections: [],
    activeConnectionId: null,
    activeTarget: null,
    projects: [],
    workspaces: [],
    sessions: [],
    bots: [],
    activeSession: null,
    truncated: false,
};
const ctx = createRootContext().named("live-controller-test");
afterEach(() => vi.useRealTimers());

function fixture(
    rounds: SessionEvent[][],
    extra: {
        appState?: LiveAppState;
        serviceTier?: string;
        results?: LiveDesktopActionResult[];
    } = {},
) {
    let round = 0;
    let options: SessionOptions | undefined;
    const requests: unknown[] = [];
    const destroy = vi.fn(async () => undefined);
    const provider = {
        session: async (_id: string, selected: SessionOptions) => {
            options = selected;
            return {
                destroy,
                run: async function* (_ctx: unknown, request: unknown) {
                    requests.push(structuredClone(request));
                    const events = rounds[round] ?? [];
                    round += 1;
                    for (const event of events) {
                        if (event.type === "text_delta") yield { type: "text_start" };
                        yield event;
                        if (event.type === "text_delta") yield { type: "text_end" };
                    }
                },
            };
        },
    } as unknown as BaseProvider;
    const results = [...(extra.results ?? [])];
    const execute = vi.fn(
        async (_action: LiveDesktopAction): Promise<LiveDesktopActionResult> =>
            results.shift() ?? { status: "succeeded", output: { type: "staged" } },
    );
    const conversation = liveControllerConversation();
    const run = async () => {
        try {
            return await runLiveController(ctx, {
                provider,
                conversation,
                model: "fixed-model",
                effort: "high",
                tools: [
                    ...LIVE_CONTROLLER_TOOLS,
                    ...LIVE_TASK_CREATE_TOOLS,
                    ...LIVE_MODEL_CHANGE_TOOLS,
                ],
                ...(extra.serviceTier === undefined ? {} : { serviceTier: extra.serviceTier }),
                context,
                ...(extra.appState === undefined ? {} : { appState: extra.appState }),
                fragments: [{ transcriptId: "fragment", role: "user", text: "send hello" }],
                signal: new AbortController().signal,
                execute,
            });
        } finally {
            closeLiveController(conversation);
        }
    };
    return { run, execute, destroy, requests, options: () => options };
}
const done: SessionEvent = { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } };
const notes = { connectionId: "local", groupId: "garden", sessionId: "notes" };
const appState: LiveAppState = {
    timeZone: "UTC",
    servers: [
        {
            connectionId: "local",
            name: "This Mac",
            kind: "local",
            online: true,
            catalog: "ready",
            bots: [],
            tasks: [],
            projects: [
                {
                    target: {
                        kind: "project",
                        connectionId: "local",
                        projectId: "observatory",
                        groupId: "observatory",
                    },
                    name: "Observatory",
                    sessions: [],
                    workspaces: [
                        {
                            target: {
                                kind: "workspace",
                                connectionId: "local",
                                projectId: "observatory",
                                workspaceId: "garden",
                                groupId: "garden",
                            },
                            name: "Garden",
                            status: "ready",
                            sessions: [
                                {
                                    target: notes,
                                    title: "Garden notes",
                                    status: "idle",
                                    lastActivityAt: null,
                                },
                            ],
                        },
                    ],
                },
            ],
            models: [
                {
                    providerId: "codex",
                    providerName: "OpenAI",
                    modelId: "openai/gpt-6.1-sol",
                    name: "GPT-6.1 Sol",
                    efforts: ["low", "medium"],
                    defaultEffort: "low",
                },
            ],
        },
    ],
    focused: null,
    truncated: false,
};

describe("bounded Live side inference", () => {
    it("enforces its deadline even when a provider iterator ignores abort and rejects late", async () => {
        vi.useFakeTimers();
        let rejectNext!: (error: Error) => void;
        const destroy = vi.fn(async () => undefined);
        const provider = {
            session: async () => ({
                destroy,
                run: () => ({
                    [Symbol.asyncIterator]: () => ({
                        next: () =>
                            new Promise((_resolve, reject) => {
                                rejectNext = reject;
                            }),
                    }),
                }),
            }),
        } as unknown as BaseProvider;
        const outcome = runLiveController(ctx, {
            provider,
            conversation: liveControllerConversation(),
            model: "fixture",
            effort: "low",
            tools: LIVE_CONTROLLER_TOOLS,
            context,
            fragments: [],
            signal: new AbortController().signal,
            execute: vi.fn(),
        }).then(
            () => "finished",
            (error) => error.category,
        );
        await vi.advanceTimersByTimeAsync(0);
        let ended: unknown;
        void outcome.then((value) => {
            ended = value;
        });
        await vi.advanceTimersByTimeAsync(123_001);
        try {
            expect(ended).toBe("deadline");
        } finally {
            rejectNext(new Error("Private late provider failure"));
            await outcome;
        }
        expect(destroy).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("releases the deadline when provider session creation fails", async () => {
        vi.useFakeTimers();
        const provider = {
            session: async () => {
                throw new Error("factory failed");
            },
        } as unknown as BaseProvider;
        await expect(
            runLiveController(ctx, {
                provider,
                conversation: liveControllerConversation(),
                model: "fixture",
                effort: "low",
                tools: LIVE_CONTROLLER_TOOLS,
                context,
                fragments: [],
                signal: new AbortController().signal,
                execute: vi.fn(),
            }),
        ).rejects.toMatchObject({ category: "inference" });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds a hanging factory and destroys its late session without inference", async () => {
        vi.useFakeTimers();
        let resolve!: (session: unknown) => void;
        const destroy = vi.fn(async () => undefined);
        const run = vi.fn();
        const provider = {
            session: () =>
                new Promise((yes) => {
                    resolve = yes;
                }),
        } as unknown as BaseProvider;
        let ended = false;
        const pending = runLiveController(ctx, {
            provider,
            conversation: liveControllerConversation(),
            model: "fixture",
            effort: "low",
            tools: LIVE_CONTROLLER_TOOLS,
            context,
            fragments: [],
            signal: new AbortController().signal,
            execute: vi.fn(),
        }).catch(() => {
            ended = true;
        });
        await vi.advanceTimersByTimeAsync(120_001);
        try {
            expect(ended).toBe(true);
        } finally {
            resolve({ destroy, run });
            await pending;
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(run).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects oversized initial context before opening provider inference", async () => {
        const session = vi.fn();
        const provider = { session } as unknown as BaseProvider;
        await expect(
            runLiveController(ctx, {
                provider,
                conversation: liveControllerConversation(),
                model: "fixture",
                effort: "low",
                tools: LIVE_CONTROLLER_TOOLS,
                context,
                fragments: [],
                delegationText: "x".repeat(512 * 1024),
                signal: new AbortController().signal,
                execute: vi.fn(),
            }),
        ).rejects.toMatchObject({
            category: "limit",
            voiceContext: expect.stringContaining("Start a new voice call"),
        });
        expect(session).not.toHaveBeenCalled();
    });
    it("keeps voice open without requiring a fresh conversation after an oversized response", async () => {
        const f = fixture([
            [
                { type: "text_delta", delta: "x".repeat(8193) },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
        ]);
        await expect(f.run()).rejects.toMatchObject({
            category: "limit",
            voiceContext: expect.stringContaining(
                "Continue the conversation without replaying this request.",
            ),
        });
        expect(f.execute).not.toHaveBeenCalled();
    });
    it("exposes fixed desktop tool arrays and reports a staged message without another inference", async () => {
        const f = fixture(
            [
                [
                    { type: "toolcall_start", callId: "c1", name: "sessionSend" },
                    {
                        type: "toolcall_end",
                        callId: "c1",
                        arguments: JSON.stringify({ target: notes, text: "hello" }),
                    },
                    done,
                ],
            ],
            { appState, serviceTier: "priority" },
        );
        await expect(f.run()).resolves.toEqual({
            text: "Staged the message in Garden notes. It has not been sent; the person must review it and press Send.",
            outcome: "fixed",
        });
        expect(LIVE_CONTROLLER_TOOLS.map((tool) => tool.name)).toEqual([
            "desktopState",
            "desktopOpen",
            "sessionRead",
            "sessionSend",
            "sessionWatch",
            "composerDraftAppend",
        ]);
        expect(LIVE_TASK_CREATE_TOOLS.map((tool) => tool.name)).toEqual(["taskCreate"]);
        expect(LIVE_MODEL_CHANGE_TOOLS.map((tool) => tool.name)).toEqual(["sessionModelChange"]);
        expect(f.options()).toMatchObject({ inferenceMaxRetries: 0 });
        expect(f.options()!.tools!.map((tool) => tool.name)).toHaveLength(8);
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({ effort: "high", serviceTier: "priority" });
        expect(f.execute).toHaveBeenCalledOnce();
        expect(f.destroy).toHaveBeenCalledOnce();
    });

    it("runs a batch in order and answers its verified actions with one fixed outcome", async () => {
        const f = fixture(
            [
                [
                    { type: "text_delta", delta: "Opening it now." },
                    { type: "toolcall_start", callId: "open", name: "desktopOpen" },
                    {
                        type: "toolcall_end",
                        callId: "open",
                        arguments: JSON.stringify({ target: { kind: "session", ...notes } }),
                    },
                    { type: "toolcall_start", callId: "model", name: "sessionModelChange" },
                    {
                        type: "toolcall_end",
                        callId: "model",
                        arguments: JSON.stringify({
                            target: notes,
                            providerId: "codex",
                            modelId: "openai/gpt-6.1-sol",
                        }),
                    },
                    { type: "toolcall_start", callId: "task", name: "taskCreate" },
                    {
                        type: "toolcall_end",
                        callId: "task",
                        arguments: JSON.stringify({
                            connectionId: "local",
                            name: "Fix the build",
                            text: "Fix it",
                        }),
                    },
                    done,
                ],
            ],
            {
                appState,
                results: [
                    { status: "succeeded", output: { type: "ack" } },
                    { status: "succeeded", output: { type: "ack" } },
                    {
                        status: "succeeded",
                        output: {
                            type: "created",
                            target: {
                                kind: "task",
                                connectionId: "local",
                                groupId: "task-group",
                                sessionId: "task-session",
                                taskId: "task",
                            },
                        },
                    },
                ],
            },
        );
        await expect(f.run()).resolves.toEqual({
            text: "Opened Garden notes. Garden notes will use GPT-6.1 Sol from OpenAI for its next message. Created the task Fix the build and staged its opening text as a draft. It has not been sent; the person must review it and press Send.",
            outcome: "fixed",
        });
        expect(f.execute.mock.calls.map(([action]) => action.type)).toEqual([
            "desktopOpen",
            "sessionModelChange",
            "taskCreate",
        ]);
        expect(f.requests).toHaveLength(1);
    });

    it("answers a lone verified open with a fixed outcome", async () => {
        const f = fixture(
            [
                [
                    { type: "toolcall_start", callId: "open", name: "desktopOpen" },
                    {
                        type: "toolcall_end",
                        callId: "open",
                        arguments: JSON.stringify({ target: { kind: "session", ...notes } }),
                    },
                    done,
                ],
            ],
            { appState, results: [{ status: "succeeded", output: { type: "ack" } }] },
        );
        await expect(f.run()).resolves.toEqual({
            text: "Opened Garden notes.",
            outcome: "fixed",
        });
        expect(f.requests).toHaveLength(1);
    });

    it("stops a batch at its first refusal and lets the controller explain it", async () => {
        const f = fixture(
            [
                [
                    { type: "toolcall_start", callId: "open", name: "desktopOpen" },
                    {
                        type: "toolcall_end",
                        callId: "open",
                        arguments: JSON.stringify({ target: { kind: "session", ...notes } }),
                    },
                    { type: "toolcall_start", callId: "send", name: "sessionSend" },
                    {
                        type: "toolcall_end",
                        callId: "send",
                        arguments: JSON.stringify({ target: notes, text: "hello" }),
                    },
                    done,
                ],
                [
                    { type: "text_delta", delta: "Garden notes could not be opened." },
                    { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
                ],
            ],
            {
                results: [
                    { status: "refused", code: "notFound", message: "That conversation is gone." },
                ],
            },
        );
        await expect(f.run()).resolves.toEqual({
            text: "Garden notes could not be opened.",
            outcome: "controller",
        });
        expect(f.execute).toHaveBeenCalledOnce();
        expect(JSON.stringify(f.requests[1])).toContain("That conversation is gone.");
        expect(JSON.stringify(f.requests[1])).toContain(
            "This action was not started because an earlier action did not succeed.",
        );
    });

    it("never answers with a fixed success after an earlier round's action was refused", async () => {
        const f = fixture(
            [
                [
                    { type: "toolcall_start", callId: "send", name: "sessionSend" },
                    {
                        type: "toolcall_end",
                        callId: "send",
                        arguments: JSON.stringify({ target: notes, text: "hello" }),
                    },
                    done,
                ],
                [
                    { type: "toolcall_start", callId: "open", name: "desktopOpen" },
                    {
                        type: "toolcall_end",
                        callId: "open",
                        arguments: JSON.stringify({ target: { kind: "session", ...notes } }),
                    },
                    done,
                ],
                [
                    {
                        type: "text_delta",
                        delta: "Garden notes is open, but a draft was already there, so nothing was staged.",
                    },
                    { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
                ],
            ],
            {
                appState,
                results: [
                    { status: "refused", code: "draftConflict", message: "A draft is present." },
                    { status: "succeeded", output: { type: "ack" } },
                ],
            },
        );
        await expect(f.run()).resolves.toEqual({
            text: "Garden notes is open, but a draft was already there, so nothing was staged.",
            outcome: "controller",
        });
        expect(f.execute).toHaveBeenCalledTimes(2);
        expect(f.requests).toHaveLength(3);
    });

    it("continues through the controller after a read even when every action succeeded", async () => {
        const f = fixture(
            [
                [
                    { type: "toolcall_start", callId: "read", name: "sessionRead" },
                    {
                        type: "toolcall_end",
                        callId: "read",
                        arguments: JSON.stringify({ target: notes }),
                    },
                    done,
                ],
                [
                    { type: "toolcall_start", callId: "send", name: "sessionSend" },
                    {
                        type: "toolcall_end",
                        callId: "send",
                        arguments: JSON.stringify({ target: notes, text: "Thanks" }),
                    },
                    done,
                ],
                [
                    {
                        type: "text_delta",
                        delta: "It finished, and your thanks is staged for review.",
                    },
                    { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
                ],
            ],
            {
                results: [
                    {
                        status: "succeeded",
                        output: {
                            type: "session",
                            target: notes,
                            status: "idle",
                            messages: [],
                            truncated: false,
                        },
                    },
                    { status: "succeeded", output: { type: "staged" } },
                ],
            },
        );
        await expect(f.run()).resolves.toMatchObject({ outcome: "controller" });
        expect(f.requests).toHaveLength(3);
    });

    it("retains only user and assistant text between requests while keeping tool results inside the active exchange", async () => {
        const requests: unknown[] = [];
        let round = 0;
        const destroy = vi.fn();
        const session = vi.fn(async () => ({
            destroy,
            run: async function* (_ctx: unknown, request: unknown): AsyncGenerator<SessionEvent> {
                requests.push(structuredClone(request));
                if (round++ === 0) {
                    yield { type: "toolcall_start", callId: "private-call", name: "desktopState" };
                    yield { type: "toolcall_end", callId: "private-call", arguments: "{}" };
                    yield done;
                } else {
                    yield { type: "text_start" };
                    yield { type: "text_delta", delta: "The named desktop is open." };
                    yield { type: "text_end" };
                    yield { type: "done", state: "normal", tokens: { input: 1, output: 1 } };
                }
            },
        }));
        const options = {
            provider: { session } as unknown as BaseProvider,
            conversation: liveControllerConversation(),
            model: "fixed-model",
            effort: "low" as const,
            tools: LIVE_CONTROLLER_TOOLS,
            context,
            fragments: [],
            signal: new AbortController().signal,
            execute: vi.fn(
                async (): Promise<LiveDesktopActionResult> => ({
                    status: "succeeded",
                    output: { type: "ack" },
                }),
            ),
        };
        await runLiveController(ctx, options);
        await runLiveController(ctx, options);
        expect(session).toHaveBeenCalledOnce();
        expect(JSON.stringify(requests[1])).toContain("private-call");
        expect(JSON.stringify(requests[2])).not.toContain("private-call");
        expect(JSON.stringify(requests[2])).not.toContain("tool_result");
        expect(JSON.stringify(requests[2])).toContain("The named desktop is open.");
        expect(destroy).not.toHaveBeenCalled();
        closeLiveController(options.conversation);
    });

    it.each([
        "exec_command",
        "request_user_input",
        "set_admin",
        "send_agent_message",
        "workspaceCreate",
        "sessionCreate",
        "botCreate",
    ])("never executes an unlisted %s tool", async (name) => {
        const f = fixture([
            [
                { type: "toolcall_start", callId: "c1", name },
                { type: "toolcall_end", callId: "c1", arguments: "{}" },
                done,
            ],
        ]);
        await expect(f.run()).rejects.toThrow("invalid");
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.destroy).toHaveBeenCalledOnce();
    });

    it("starts at most four batched actions and reports the rest as not started", async () => {
        const reads = ["a", "b", "c", "d", "e"].flatMap((callId): SessionEvent[] => [
            { type: "toolcall_start", callId, name: "desktopState" },
            { type: "toolcall_end", callId, arguments: "{}" },
        ]);
        const f = fixture(
            [
                [...reads, done],
                [
                    { type: "text_delta", delta: "Four reads ran; one was not started." },
                    { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
                ],
            ],
            {
                results: Array.from({ length: 4 }, () => ({
                    status: "succeeded" as const,
                    output: { type: "ack" as const },
                })),
            },
        );
        await expect(f.run()).resolves.toMatchObject({ outcome: "controller" });
        expect(f.execute).toHaveBeenCalledTimes(4);
        expect(JSON.stringify(f.requests[1])).toContain("Use at most 4 desktop tools at a time.");
    });

    it("destroys exactly once when closing races with a provider opening", async () => {
        let open!: (value: unknown) => void;
        const destroy = vi.fn(async () => undefined);
        const conversation = liveControllerConversation();
        const run = vi.fn();
        const signal = new AbortController();
        const outcome = runLiveController(ctx, {
            provider: {
                session: () =>
                    new Promise((resolve) => {
                        open = resolve;
                    }),
            } as unknown as BaseProvider,
            conversation,
            model: "fixture",
            effort: "low",
            tools: LIVE_CONTROLLER_TOOLS,
            context,
            fragments: [],
            signal: signal.signal,
            execute: vi.fn(),
        }).catch((error) => error.category);
        open({ destroy, run });
        signal.abort();
        closeLiveController(conversation);
        expect(await outcome).toBe("deadline");
        await Promise.resolve();
        expect(run).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        expect(conversation.session).toBeUndefined();
    });
});
