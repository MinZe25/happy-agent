import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import type {
    CreateLiveSessionRequest,
    LiveAppState,
    LiveControlServerMessage,
    LiveDesktopAction,
} from "@slopus/happy-agent-client";
import type { SessionEvent, SessionOptions, SessionRunRequest } from "@slopus/happy-providers";
import { withLogger } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsModule } from "../sources/bots/index.js";
import {
    ConfigModule,
    VoiceCredentialPoolError,
    VoiceSettingsError,
} from "../sources/config/index.js";
import { DurableFunctionsModule } from "../sources/durableFunctions/index.js";
import { LiveModule } from "../sources/live/index.js";
import {
    LIVE_LATER_REQUEST_INSTRUCTIONS,
    LIVE_QUEUED_REQUEST_INSTRUCTIONS,
    LIVE_VOICE_INSTRUCTIONS,
} from "../sources/live/impl/livePrompts.js";
import type {
    LiveProviderOptions,
    LiveProviderTransport,
} from "../sources/live/impl/liveProviderTransport.js";
import { moduleDatabase } from "./support/moduleDatabase.js";

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../sources/live/impl/liveProviderTransport.js", () => ({
    createLiveProviderTransport: transport.create,
    LiveProviderError: class extends Error {},
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    transport.create.mockReset();
});

const request = (id = "liveone", windowId = "window-one"): CreateLiveSessionRequest => ({
    id,
    windowId,
    sdp: "v=fixture",
    credential: { type: "openai_api_key", providerId: "fixture" },
    contextRevision: 1,
    context: {
        windowId,
        connections: [],
        activeConnectionId: null,
        activeTarget: null,
        projects: [],
        workspaces: [],
        sessions: [],
        bots: [],
        activeSession: null,
        truncated: false,
    },
});

const tokens = { input: 1, output: 1 };
const say = (text: string): SessionEvent[] => [
    { type: "text_start" },
    { type: "text_delta", delta: text },
    { type: "text_end" },
    { type: "done", state: "normal", tokens },
];

interface ControllerStep {
    action?: LiveDesktopAction;
    reply: string;
    gate?: Promise<void>;
    fail?: true;
}

/**
 * One persistent controller session that answers by request content, never by call order.
 * Each step is chosen by a marker in the newest controller input; its tool call reuses that marker.
 */
function controllerSession(steps: Record<string, ControllerStep>) {
    const requests: SessionRunRequest[] = [];
    const signals: AbortSignal[] = [];
    const destroy = vi.fn(async () => undefined);
    const session = {
        destroy,
        run: async function* (ctx: unknown, input: unknown): AsyncGenerator<SessionEvent> {
            const request = structuredClone(input) as SessionRunRequest;
            requests.push(request);
            signals.push((ctx as { lifetime: AbortSignal }).lifetime);
            const last = request.context.messages.at(-1);
            const resultFor =
                last?.role === "tool" ? (last as { callId: string }).callId : undefined;
            const marker =
                resultFor ?? Object.keys(steps).find((key) => JSON.stringify(last).includes(key));
            const step = marker === undefined ? undefined : steps[marker];
            if (marker === undefined || step === undefined)
                throw new Error("Unexpected controller request.");
            await step.gate;
            if (step.fail) {
                yield { type: "done", state: "error", kind: "unknown", message: "Private failure" };
            } else if (resultFor === undefined && step.action !== undefined) {
                const { type, ...arguments_ } = step.action;
                yield { type: "toolcall_start", callId: marker, name: type };
                yield {
                    type: "toolcall_end",
                    callId: marker,
                    arguments: JSON.stringify(arguments_),
                };
                yield { type: "done", state: "tool_call", tokens };
            } else yield* say(step.reply);
        },
    };
    return { session, requests, signals, destroy };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type ActionFrame = Extract<LiveControlServerMessage, { type: "actionRequested" }>;

async function activeCall(f: Fixture, body = request()) {
    await f.start(body);
    const control = await f.attach();
    f.calls[0]!.onEvent({ type: "ready" });
    await expect
        .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
        .toBe("active");
    return {
        ...control,
        speak: (text: string) => f.calls[0]!.onEvent({ type: "transcript", role: "user", text }),
        delegate: (delegationId: string) =>
            f.calls[0]!.onEvent({ type: "delegation", delegationId }),
        transcripts: () => control.frames.filter((frame) => frame.type === "transcript"),
        actions: () =>
            control.frames.filter(
                (frame): frame is ActionFrame => frame.type === "actionRequested",
            ),
        answer: (action: ActionFrame, result: unknown) =>
            control.binding.message(
                JSON.stringify({ type: "actionResult", actionId: action.actionId, result }),
            ),
    };
}

async function fixture(startDurable = true) {
    const inferenceRequests: unknown[] = [];
    const controllerLifetime = new AbortController();
    const provider = {
        session: vi.fn(async () => ({
            destroy: vi.fn(async () => undefined),
            run: async function* (_ctx: unknown, request: unknown): AsyncGenerator<SessionEvent> {
                inferenceRequests.push(request);
                yield { type: "text_start" };
                yield { type: "text_delta", delta: "Ready." };
                yield { type: "text_end" };
                yield { type: "done", state: "normal", tokens: { input: 1, output: 1 } };
            },
        })),
    };
    const config = {
        liveControllerRoute: vi.fn(async () => ({
            provider,
            model: { providerId: "fixture", id: "fixture", defaultEffort: "low" },
            effort: "low",
            signal: controllerLifetime.signal,
        })),
        liveCredential: vi.fn(async () => ({ type: "openai_api_key", token: "fake" })),
        voiceSettings: {},
    } as unknown as ConfigModule;
    const bots = { forAgent: vi.fn(async () => undefined) } as unknown as BotsModule;
    const durable = new DurableFunctionsModule();
    const live = new LiveModule(config, durable, bots);
    const db = moduleDatabase([...durable.migrations, ...live.migrations], "live-test");
    ensureAgentDatabaseConnection(db.database);
    await db.ready;
    const hooks = durable.beforeStart(db.context);
    const info = vi.fn();
    const liveHooks = await live.beforeStart(
        withLogger(db.context, {
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            fatal: vi.fn(),
            info,
            trace: vi.fn(),
        }),
    );
    if (startDurable) await hooks.afterStart?.(db.context, {} as never);
    const calls: LiveProviderOptions[] = [];
    const append = vi.fn(
        async (_input: Parameters<LiveProviderTransport["append"]>[0]): Promise<void> => undefined,
    );
    transport.create.mockImplementation(async (options: LiveProviderOptions) => {
        calls.push(options);
        return {
            sdp: "v=answer",
            append,
            close: async () => options.onEvent({ type: "ended", orderly: true, error: null }),
            dispose: vi.fn(),
        };
    });
    const events: unknown[] = [];
    live.onEvent((event) => events.push(event));
    cleanups.push(async () => {
        await live.stop();
        durable.stop();
        await Promise.resolve();
        db.close();
    });
    const start = async (body = request(), owner = "owner") => {
        const reserved = await live.reserve(db.context, owner, body);
        await expect(reserved.allocated).resolves.toBe("v=answer");
        return reserved.session.id;
    };
    const attach = async (id = "liveone", owner = "owner", window = "window-one") => {
        const frames: LiveControlServerMessage[] = [];
        const close = vi.fn();
        const prepared = await live.prepareControl(db.context, owner, id, window);
        const binding = prepared.attach({ send: (text) => frames.push(JSON.parse(text)), close });
        return { frames, binding, close };
    };
    return {
        live,
        db,
        durable,
        config,
        bots,
        liveHooks,
        calls,
        events,
        start,
        attach,
        append,
        provider,
        inferenceRequests,
        controllerLifetime,
        info,
    };
}

describe("window-owned Live sessions", () => {
    it("expires a queued request without starting it and fences a stalled provider before a later request", async () => {
        const f = await fixture();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const destroy = vi.fn(async () => undefined);
        f.provider.session.mockImplementationOnce(async () => ({
            destroy,
            run: async function* (): AsyncGenerator<SessionEvent> {
                await gate;
                yield { type: "toolcall_start", callId: "late", name: "desktopState" };
                yield { type: "toolcall_end", callId: "late", arguments: "{}" };
                yield { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } };
            },
        }));
        await f.start();
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await vi.waitFor(() => expect(control.frames.at(-1)).toMatchObject({ status: "active" }));
        vi.useFakeTimers();
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "stalled" });
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "expired" });
        await vi.advanceTimersByTimeAsync(123_001);
        expect(f.append.mock.calls).toHaveLength(2);
        expect(f.append.mock.calls[1]![0]).toMatchObject({
            delegationId: "expired",
            text: expect.stringContaining("No action was started"),
        });
        expect(f.provider.session).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(control.frames.filter((frame) => frame.type === "actionRequested")).toHaveLength(0);
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "new-request" });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.provider.session).toHaveBeenCalledTimes(2);
        expect(f.append.mock.calls.at(-1)![0]).toMatchObject({
            delegationId: "new-request",
            text: `Ready.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
        });
        expect(destroy).toHaveBeenCalledOnce();
    });
    it("keeps quiet AppState fresh after two thousand changes without a lifetime cutoff", async () => {
        const f = await fixture();
        await f.start();
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await vi.waitFor(() => expect(control.frames.at(-1)).toMatchObject({ status: "active" }));
        vi.useFakeTimers();
        for (let index = 0; index < 2000; index++) {
            control.binding.message(
                JSON.stringify({
                    type: "desktopContext",
                    revision: index + 2,
                    context: {
                        ...request().context,
                        connections: [
                            { connectionId: "connection", name: `Desktop ${index}`, online: true },
                        ],
                    },
                }),
            );
            await vi.advanceTimersByTimeAsync(251);
        }
        expect(f.append).toHaveBeenCalledTimes(2000);
        expect(f.append.mock.calls.at(-1)![0]).toMatchObject({
            delegationId: null,
            speakable: false,
            text: expect.stringContaining("Desktop 1999"),
        });
        expect(f.append.mock.calls.every(([input]) => Buffer.byteLength(input.text) <= 500)).toBe(
            true,
        );
    }, 20_000);

    it("coalesces AppState changes during an in-flight update and skips identical snapshots", async () => {
        const f = await fixture();
        let finish!: () => void;
        f.append.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        await f.start();
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await vi.waitFor(() => expect(control.frames.at(-1)).toMatchObject({ status: "active" }));
        vi.useFakeTimers();
        const update = async (revision: number, name: string) => {
            control.binding.message(
                JSON.stringify({
                    type: "desktopContext",
                    revision,
                    context: {
                        ...request().context,
                        connections: [{ connectionId: "connection", name, online: true }],
                    },
                }),
            );
            await vi.advanceTimersByTimeAsync(251);
        };
        await update(2, "First desktop");
        expect(f.append).toHaveBeenCalledOnce();
        await update(3, "Intermediate desktop");
        await update(4, "Latest desktop");
        expect(f.append).toHaveBeenCalledOnce();
        finish();
        await vi.advanceTimersByTimeAsync(251);
        expect(f.append).toHaveBeenCalledTimes(2);
        expect(f.append.mock.calls[1]![0].text).toContain("Latest desktop");
        expect(JSON.stringify(f.append.mock.calls)).not.toContain("Intermediate desktop");
        await update(5, "Latest desktop");
        expect(f.append).toHaveBeenCalledTimes(2);
    });
    it("queues follow-ups on one controller conversation and refreshes desktop state when their turn starts", async () => {
        const f = await fixture();
        let finishFirst!: () => void;
        let turn = 0;
        const requests: SessionRunRequest[] = [];
        const destroy = vi.fn(async () => undefined);
        f.provider.session.mockImplementation(async () => ({
            destroy,
            run: async function* (_ctx: unknown, input: unknown): AsyncGenerator<SessionEvent> {
                requests.push(structuredClone(input) as SessionRunRequest);
                if (turn++ === 0)
                    await new Promise<void>((resolve) => {
                        finishFirst = resolve;
                    });
                yield { type: "text_start" };
                yield { type: "text_delta", delta: "A text-only answer." };
                yield { type: "text_end" };
                yield { type: "done", state: "normal", tokens: { input: 1, output: 1 } };
            },
        }));
        await f.start();
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await vi.waitFor(() => expect(control.frames.at(-1)).toMatchObject({ status: "active" }));
        f.calls[0]!.onEvent({ type: "transcript", role: "user", text: "First question" });
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "queue-first" });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        f.calls[0]!.onEvent({ type: "transcript", role: "user", text: "Follow-up question" });
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "queue-second" });
        control.binding.message(
            JSON.stringify({
                type: "desktopContext",
                revision: 2,
                context: {
                    ...request().context,
                    connections: [{ connectionId: "fresh", name: "Current desktop", online: true }],
                },
            }),
        );
        await vi.waitFor(() =>
            expect(f.info.mock.calls.map((args) => JSON.parse(args.at(-1)!))).toContainEqual(
                expect.objectContaining({ event: "context.accepted", contextRevision: 2 }),
            ),
        );
        try {
            expect(requests).toHaveLength(1);
            expect(f.provider.session).toHaveBeenCalledOnce();
        } finally {
            finishFirst();
        }
        await vi.waitFor(() => expect(f.append).toHaveBeenCalledTimes(2));
        expect(f.provider.session).toHaveBeenCalledOnce();
        expect(JSON.stringify(requests[1])).toContain("Current desktop");
        expect(JSON.stringify(requests[1])).toContain("A text-only answer.");
        expect(destroy).not.toHaveBeenCalled();
        await f.live.close(f.db.context, "owner", "liveone");
        await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    });
    it("bounds transcript diagnostic bursts and lifetime output while preserving every desktop fragment", async () => {
        const f = await fixture();
        await f.start();
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        for (let index = 0; index < 3; index++)
            f.calls[0]!.onEvent({
                type: "transcript",
                role: "user",
                text: "Private speech sentinel",
            });
        await expect
            .poll(() => control.frames.filter((frame) => frame.type === "transcript").length)
            .toBe(3);
        const records = () => f.info.mock.calls.map((args) => JSON.parse(args.at(-1)!));
        expect(records().filter((record) => record.event === "transcript.received")).toHaveLength(
            1,
        );
        clock.mockImplementation(() => (now += 100));
        for (let index = 0; index < 1028; index++) {
            f.calls[0]!.onEvent({
                type: "transcript",
                role: "user",
                text: "Private speech sentinel",
            });
            if ((index + 1) % 32 === 0 || index === 1027)
                await expect
                    .poll(
                        () => control.frames.filter((frame) => frame.type === "transcript").length,
                        { interval: 1 },
                    )
                    .toBe(index + 4);
        }
        await f.live.close(f.db.context, "owner", "liveone");
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("closed");
        expect(records().filter((record) => record.event === "transcript.received")).toHaveLength(
            1024,
        );
        expect(records().at(-1)).toMatchObject({
            event: "session.status",
            status: "closed",
            suppressed: 7,
        });
        expect(JSON.stringify(f.info.mock.calls)).not.toContain("Private speech sentinel");
        clock.mockRestore();
    });

    it("keeps voice and controller delivery working when every metadata log write throws", async () => {
        const f = await fixture();
        f.info.mockImplementation(() => {
            throw new Error("Private logger failure");
        });
        await f.start();
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "logger-unavailable" });
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        expect(f.append).toHaveBeenCalledWith({
            delegationId: "logger-unavailable",
            text: `Ready.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
            speakable: true,
        });
        expect(control.close).not.toHaveBeenCalled();
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it("returns a safe controller error as voice context and accepts a follow-up on the same call", async () => {
        const f = await fixture();
        f.provider.session.mockRejectedValueOnce(new Error("Secret token and private transcript"));
        await f.start();
        const attached = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "failure" });
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        expect(f.append).toHaveBeenCalledWith(
            expect.objectContaining({
                delegationId: "failure",
                speakable: true,
                text: expect.stringContaining("could not complete"),
            }),
        );
        expect(JSON.stringify(f.append.mock.calls)).not.toContain("Secret token");
        expect(JSON.stringify(f.info.mock.calls)).not.toContain("Secret token");
        expect(f.info.mock.calls.map((args) => JSON.parse(args.at(-1)!))).toContainEqual(
            expect.objectContaining({
                event: "controller.failed",
                delegationId: "failure",
                category: "inference",
            }),
        );
        expect(await f.live.get(f.db.context, "owner", "liveone")).toMatchObject({
            status: "active",
            error: null,
        });
        expect(attached.close).not.toHaveBeenCalled();
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "followup" });
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        expect(f.append).toHaveBeenLastCalledWith({
            delegationId: "followup",
            speakable: true,
            text: `Ready.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
        });
        expect(f.provider.session).toHaveBeenCalledTimes(2);
        expect(transport.create).toHaveBeenCalledOnce();
    });

    it.each([false, true])(
        "ends a lost response transport without attempting a second delivery (controller error: %s)",
        async (controllerError) => {
            const f = await fixture();
            if (controllerError)
                f.provider.session.mockRejectedValueOnce(
                    new Error("Private controller diagnostic"),
                );
            f.append.mockRejectedValueOnce(new Error("Private socket diagnostic"));
            await f.start();
            const attached = await f.attach();
            f.calls[0]!.onEvent({ type: "ready" });
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("active");
            f.calls[0]!.onEvent({ type: "delegation", delegationId: "delivery" });
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("failed");
            expect(f.append).toHaveBeenCalledOnce();
            expect(attached.close).toHaveBeenCalledOnce();
            expect((await f.live.get(f.db.context, "owner", "liveone")).error).toContain(
                "could not deliver",
            );
        },
    );

    it("keeps a controller deadline and unavailable diagnostic logger within the current delegation", async () => {
        const f = await fixture();
        f.provider.session.mockImplementationOnce(() => new Promise(() => {}));
        f.info.mockImplementation(() => {
            throw new Error("Logger unavailable");
        });
        await f.start();
        const attached = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        vi.useFakeTimers();
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "deadline" });
        await vi.advanceTimersByTimeAsync(120_001);
        vi.useRealTimers();
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        expect(f.append).toHaveBeenCalledWith(
            expect.objectContaining({ text: expect.stringContaining("before its deadline") }),
        );
        expect(attached.close).not.toHaveBeenCalled();
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "after-deadline" });
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        expect(f.append).toHaveBeenLastCalledWith({
            delegationId: "after-deadline",
            speakable: true,
            text: `Ready.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
        });
    });

    it("reports an uncertain desktop timeout, ignores its late result, and continues without replay", async () => {
        const f = await fixture();
        let attempted = false;
        f.provider.session.mockImplementationOnce(async () => ({
            destroy: vi.fn(async () => undefined),
            run: async function* (): AsyncGenerator<SessionEvent> {
                if (attempted) {
                    yield { type: "text_start" };
                    yield { type: "text_delta", delta: "Ready." };
                    yield { type: "text_end" };
                    yield { type: "done", state: "normal", tokens: { input: 1, output: 1 } };
                    return;
                }
                attempted = true;
                yield { type: "toolcall_start", callId: "read", name: "desktopState" };
                yield { type: "toolcall_end", callId: "read", arguments: "{}" };
                yield { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } };
            },
        }));
        await f.start();
        const attached = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        vi.useFakeTimers();
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "timeout" });
        await vi.advanceTimersByTimeAsync(0);
        const action = attached.frames.find((frame) => frame.type === "actionRequested");
        expect(action?.type).toBe("actionRequested");
        await vi.advanceTimersByTimeAsync(60_001);
        vi.useRealTimers();
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        expect(f.append).toHaveBeenCalledWith(
            expect.objectContaining({
                text: expect.stringContaining("did not return a confirmed outcome"),
            }),
        );
        if (action?.type !== "actionRequested") throw new Error("Missing action");
        attached.binding.message(
            JSON.stringify({
                type: "actionResult",
                actionId: action.actionId,
                result: { status: "succeeded", output: { type: "ack" } },
            }),
        );
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "after-timeout" });
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        expect(f.append).toHaveBeenLastCalledWith({
            delegationId: "after-timeout",
            speakable: true,
            text: `Ready.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
        });
        expect(attached.frames.filter((frame) => frame.type === "actionRequested")).toHaveLength(1);
        expect(await f.live.get(f.db.context, "owner", "liveone")).toMatchObject({
            status: "active",
            error: null,
        });
    });

    it("preserves uncertainty after a successful mutation followed by a provider failure", async () => {
        const f = await fixture();
        let round = 0;
        f.provider.session.mockImplementationOnce(async () => ({
            destroy: vi.fn(async () => undefined),
            run: async function* (): AsyncGenerator<SessionEvent> {
                if (round++ > 0) {
                    yield {
                        type: "done",
                        state: "error",
                        kind: "unknown",
                        message: "Private failure",
                    };
                    return;
                }
                for (const [callId, name, args] of [
                    [
                        "stage",
                        "sessionSend",
                        { target: gardenNotes, text: "Keep this exact text." },
                    ],
                    ["read", "desktopState", {}],
                ] as const) {
                    yield { type: "toolcall_start", callId, name };
                    yield { type: "toolcall_end", callId, arguments: JSON.stringify(args) };
                }
                yield { type: "done", state: "tool_call", tokens };
            },
        }));
        const initial = voiceRequest();
        initial.context.activeSession = {
            target: gardenNotes,
            status: "idle",
            messages: [],
            composerHasDraft: false,
            writeRefusal: null,
        };
        const call = await activeCall(f, initial);
        call.delegate("partial");
        await expect.poll(() => call.actions().length).toBe(1);
        call.answer(call.actions()[0]!, { status: "succeeded", output: { type: "staged" } });
        await expect.poll(() => call.actions().length).toBe(2);
        call.answer(call.actions()[1]!, {
            status: "succeeded",
            output: { type: "context", context: initial.context },
        });
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        const outcome = f.append.mock.calls[0]![0].text;
        expect(outcome).toContain("Some actions may already have completed");
        expect(outcome).toContain("Do not retry any action automatically");
        expect(outcome).not.toContain("No action was started");
        expect(outcome).not.toContain("Private failure");
        expect(f.calls[0]!.instructions).toContain("An omitted action has an unknown outcome");
        expect(f.calls[0]!.instructions).not.toContain("say that part was not done");
        expect(call.actions().map((frame) => frame.action.type)).toEqual([
            "sessionSend",
            "desktopState",
        ]);
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it("explains a proven voice credential pool selection before allocating a call", async () => {
        const f = await fixture();
        vi.mocked(f.config.liveCredential).mockRejectedValueOnce(new VoiceCredentialPoolError());
        await expect(f.live.reserve(f.db.context, "owner", request())).rejects.toMatchObject({
            status: 503,
            code: "live_unavailable",
            message:
                "Select an individual OpenAI account for voice; account pools cannot supply voice credentials.",
        });
        expect(f.events).toEqual([]);
        expect(transport.create).not.toHaveBeenCalled();
    });

    it.each(["controller", "credential"])(
        "identifies the failing %s setup without exposing caught diagnostics or allocating a call",
        async (stage) => {
            const f = await fixture();
            const error = new Error("Sensitive provider diagnostic that must stay private.");
            if (stage === "controller")
                vi.mocked(f.config.liveControllerRoute).mockRejectedValueOnce(error);
            else vi.mocked(f.config.liveCredential).mockRejectedValueOnce(error);
            await expect(f.live.reserve(f.db.context, "owner", request())).rejects.toMatchObject({
                status: 503,
                code: "live_unavailable",
                message:
                    stage === "controller"
                        ? "Voice cannot use the selected controller model. Check the voice settings and the selected account."
                        : "Voice cannot use the selected OpenAI credential. Check that the selected account is enabled, signed in, and holds the selected credential type.",
            });
            expect(f.events).toEqual([]);
            expect(transport.create).not.toHaveBeenCalled();
        },
    );

    it("cancels controller work when its configured route is disabled without retrying", async () => {
        const f = await fixture();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        let release!: () => void;
        f.provider.session.mockImplementationOnce(async () => ({
            destroy: vi.fn(async () => undefined),
            run: async function* (ctx: unknown): AsyncGenerator<SessionEvent> {
                const signal = (ctx as { lifetime: AbortSignal }).lifetime;
                await new Promise<void>((resolve) => {
                    release = resolve;
                    signal.addEventListener("abort", () => resolve(), { once: true });
                    started();
                });
                yield { type: "done", state: "cancelled" };
            },
        }));
        await f.start();
        await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "disabled-route" });
        await running;
        try {
            f.controllerLifetime.abort();
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("failed");
            expect(f.provider.session).toHaveBeenCalledTimes(1);
        } finally {
            release();
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("failed");
        }
    });

    it("ends a claimed call immediately when its controller upgrade fails", async () => {
        const f = await fixture();
        await f.start();
        const prepared = await f.live.prepareControl(
            f.db.context,
            "owner",
            "liveone",
            "window-one",
        );
        prepared.failed();
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("failed");
        await expect(f.attach()).rejects.toMatchObject({ status: 409 });
    });
    it("ignores a repeated delegation and delivers each reply before the next queued request runs", async () => {
        const f = await fixture();
        const controller = controllerSession({
            "first-request": { reply: "First reply." },
            "second-request": { reply: "Second reply." },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        let release!: () => void;
        f.append.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const call = await activeCall(f);
        call.speak("first-request");
        call.delegate("first");
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        call.delegate("first");
        call.speak("second-request");
        call.delegate("second");
        // The first reply is handed over without waiting for the queued inference, and the queued
        // request starts only once that reply is delivered.
        expect(controller.requests).toHaveLength(1);
        release();
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        expect(f.append.mock.calls.map(([input]) => input)).toEqual([
            {
                delegationId: "first",
                text: `First reply.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
                speakable: true,
            },
            {
                delegationId: "second",
                text: `Second reply.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
                speakable: true,
            },
        ]);
        expect(controller.requests).toHaveLength(2);
        expect(f.provider.session).toHaveBeenCalledOnce();
        expect(JSON.stringify(f.append.mock.calls)).not.toContain("busy");
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it("runs a queued follow-up after the active request fails and retains only text", async () => {
        const f = await fixture();
        let failFirst!: () => void;
        const gate = new Promise<void>((resolve) => {
            failFirst = resolve;
        });
        const controller = controllerSession({
            "failing-request": { reply: "", fail: true, gate },
            "follow-up-request": {
                action: { type: "desktopState" },
                reply: "Follow-up completed.",
            },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        const call = await activeCall(f);
        call.speak("failing-request");
        call.delegate("failing");
        await expect.poll(() => controller.requests.length).toBe(1);
        call.speak("follow-up-request");
        call.delegate("follow-up");
        // Provider events are handled in order, so this transcript proves the follow-up was accepted.
        call.speak("barrier");
        await expect.poll(() => call.transcripts().length).toBe(3);
        expect(controller.requests).toHaveLength(1);
        failFirst();
        await expect.poll(() => call.actions().length).toBe(1);
        expect(f.append.mock.calls[0]![0]).toMatchObject({
            delegationId: "failing",
            text: expect.stringContaining("could not complete"),
        });
        expect(f.append.mock.calls[0]![0].text).toContain(LIVE_QUEUED_REQUEST_INSTRUCTIONS);
        call.answer(call.actions()[0]!, {
            status: "succeeded",
            output: { type: "context", context: request().context },
        });
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        expect(f.append).toHaveBeenLastCalledWith({
            delegationId: "follow-up",
            text: `Follow-up completed.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
            speakable: true,
        });
        const history = controller.requests[1]!.context.messages;
        expect(history.slice(0, -1)).toEqual([
            { role: "user", content: [{ type: "text", text: "failing-request" }] },
            {
                role: "assistant",
                content: [{ type: "text", text: expect.stringContaining("could not complete") }],
            },
        ]);
        expect(JSON.stringify(controller.requests)).not.toContain("Private failure");
        expect(JSON.stringify(controller.requests)).not.toContain(LIVE_LATER_REQUEST_INSTRUCTIONS);
        expect(JSON.stringify(controller.requests)).not.toContain(LIVE_QUEUED_REQUEST_INSTRUCTIONS);
        expect(f.provider.session).toHaveBeenCalledOnce();
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it("reminds voice to delegate later requests after each outcome without retaining that instruction in controller history", async () => {
        const f = await fixture();
        const controller = controllerSession({
            "first-handoff": { reply: "First reply." },
            "second-handoff": { reply: "Second reply." },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        const call = await activeCall(f);
        call.speak("first-handoff");
        call.delegate("first");
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        call.speak("second-handoff");
        call.delegate("second");
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        for (const [input] of f.append.mock.calls) {
            expect(input.text).toContain(
                "If the person made a request after this one that you have not delegated, delegate it now; saying you will do it does not do it.",
            );
        }
        expect(controller.requests[1]!.context.messages.slice(0, 2)).toEqual([
            { role: "user", content: [{ type: "text", text: "first-handoff" }] },
            { role: "assistant", content: [{ type: "text", text: "First reply." }] },
        ]);
        expect(JSON.stringify(controller.requests)).not.toContain("delegate it now");
        expect(call.actions()).toEqual([]);
        expect(f.provider.session).toHaveBeenCalledOnce();
    });

    it("tells voice to wait for an already queued request and reserves the handoff reminder for the last outcome", async () => {
        const f = await fixture();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const controller = controllerSession({
            "first-request": { reply: "First reply.", gate },
            "second-request": { reply: "Second reply." },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        const call = await activeCall(f);
        call.speak("first-request");
        call.delegate("first");
        await expect.poll(() => controller.requests.length).toBe(1);
        call.speak("second-request");
        call.delegate("second");
        call.speak("barrier");
        await expect.poll(() => call.transcripts().length).toBe(3);
        expect(f.append).not.toHaveBeenCalled();
        release();
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        expect(f.append.mock.calls[0]![0].text).toBe(
            "First reply.\n\nRequests you delegated after this one are still in progress and will each get their own outcome; do not delegate them again. Still delegate any new request the person makes.",
        );
        expect(f.append.mock.calls[0]![0].text).not.toContain("delegate it now");
        expect(LIVE_QUEUED_REQUEST_INSTRUCTIONS).toContain("Still delegate any new request");
        expect(f.append.mock.calls[1]![0].text).toContain(LIVE_LATER_REQUEST_INSTRUCTIONS);
        expect(JSON.stringify(controller.requests)).not.toContain("delegate it now");
        expect(JSON.stringify(controller.requests)).not.toContain("do not delegate them again");
        expect(f.info.mock.calls.map((args) => JSON.parse(args.at(-1)!))).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    event: "delegation.queued",
                    delegationId: "first",
                    inFlight: 1,
                }),
                expect.objectContaining({
                    event: "delegation.queued",
                    delegationId: "second",
                    inFlight: 2,
                }),
                expect.objectContaining({
                    event: "delegation.delivered",
                    delegationId: "first",
                    inFlight: 2,
                    outcomeHint: "queued",
                }),
                expect.objectContaining({
                    event: "delegation.delivered",
                    delegationId: "second",
                    inFlight: 1,
                    outcomeHint: "later",
                }),
            ]),
        );
        expect(JSON.stringify(f.info.mock.calls)).not.toContain("First reply.");
        expect(JSON.stringify(f.info.mock.calls)).not.toContain("second-request");
        expect(call.actions()).toEqual([]);
        expect(f.provider.session).toHaveBeenCalledOnce();
    });

    it("starts a queued request's sixty-second action deadline when its action is dispatched", async () => {
        const f = await fixture();
        const controller = controllerSession({
            "first-action": { action: { type: "desktopState" }, reply: "First completed." },
            "queued-action": { action: { type: "desktopState" }, reply: "Queued completed." },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        const call = await activeCall(f);
        const context = {
            status: "succeeded",
            output: { type: "context", context: request().context },
        };
        vi.useFakeTimers();
        call.speak("first-action");
        call.delegate("first");
        await vi.advanceTimersByTimeAsync(0);
        expect(call.actions()).toHaveLength(1);
        call.speak("queued-action");
        call.delegate("queued");
        await vi.advanceTimersByTimeAsync(50_000);
        expect(call.actions()).toHaveLength(1);
        call.answer(call.actions()[0]!, context);
        await vi.advanceTimersByTimeAsync(0);
        expect(call.actions()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(f.append.mock.calls.map(([input]) => input)).toEqual([
            {
                delegationId: "first",
                text: `First completed.\n\n${LIVE_QUEUED_REQUEST_INSTRUCTIONS}`,
                speakable: true,
            },
        ]);
        call.answer(call.actions()[1]!, context);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.append).toHaveBeenLastCalledWith({
            delegationId: "queued",
            text: `Queued completed.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
            speakable: true,
        });
        expect(JSON.stringify(f.append.mock.calls)).not.toContain("confirmed outcome");
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it("cancels the active action and queued requests on close and destroys the controller once", async () => {
        const f = await fixture();
        const controller = controllerSession({
            "active-action": { action: { type: "desktopState" }, reply: "Active completed." },
            "queued-request": { reply: "Queued completed." },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        const call = await activeCall(f);
        call.speak("active-action");
        call.delegate("active");
        await expect.poll(() => call.actions().length).toBe(1);
        call.speak("queued-request");
        call.delegate("queued");
        call.speak("barrier");
        await expect.poll(() => call.transcripts().length).toBe(3);
        await f.live.close(f.db.context, "owner", "liveone");
        await expect
            .poll(() => call.frames)
            .toContainEqual(expect.objectContaining({ type: "status", status: "closed" }));
        await expect.poll(() => controller.destroy.mock.calls.length).toBe(1);
        expect(controller.signals.every((signal) => signal.aborted)).toBe(true);
        call.answer(call.actions()[0]!, {
            status: "succeeded",
            output: { type: "context", context: request().context },
        });
        expect(controller.requests).toHaveLength(1);
        expect(f.append).not.toHaveBeenCalled();
        expect(controller.destroy).toHaveBeenCalledOnce();
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("closed");
    });

    it("keeps five watched conversations across queued requests and releases a refused watch", async () => {
        const f = await fixture();
        const targets = Array.from({ length: 7 }, (_, index) => ({
            connectionId: "connection",
            groupId: "group",
            sessionId: `session${index}`,
        }));
        const controller = controllerSession(
            Object.fromEntries(
                targets.map((target, index) => [
                    `watch${index}`,
                    {
                        action: { type: "sessionWatch", target, enabled: true },
                        reply: `Watch ${index} handled.`,
                    } satisfies ControllerStep,
                ]),
            ),
        );
        f.provider.session.mockImplementation(async () => controller.session);
        const body = request();
        body.context.sessions = targets.map((target) => ({
            target,
            title: "Private watch title",
            status: "idle",
        }));
        const call = await activeCall(f, body);
        for (let index = 0; index < targets.length; index++) {
            call.speak(`watch${index}`);
            call.delegate(`watch${index}`);
        }
        for (let index = 0; index < 6; index++) {
            await expect.poll(() => call.actions().length).toBe(index + 1);
            call.answer(
                call.actions()[index]!,
                index === 0
                    ? { status: "refused", code: "unavailable", message: "Unavailable watch" }
                    : { status: "succeeded", output: { type: "ack" } },
            );
        }
        await expect.poll(() => f.append.mock.calls.length).toBe(7);
        expect(call.actions().map((frame) => frame.action)).toEqual(
            targets.slice(0, 6).map((target) => ({ type: "sessionWatch", target, enabled: true })),
        );
        expect(f.append).toHaveBeenLastCalledWith({
            delegationId: "watch6",
            text: `Watch 6 handled.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
            speakable: true,
        });
        expect(JSON.stringify(controller.requests.at(-1))).toContain(
            "At most five conversations can be watched.",
        );
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it.each([false, true])(
        "gives a queued request fresh desktop context while keeping its own speech attribution (draft conflict: %s)",
        async (conflict) => {
            const f = await fixture();
            const initialTarget = {
                connectionId: "connection",
                groupId: "group",
                sessionId: "initial",
            };
            const openedTarget = { ...initialTarget, sessionId: "opened" };
            const body = request();
            body.context.activeTarget = { kind: "session", ...initialTarget };
            body.context.activeSession = {
                target: initialTarget,
                status: "idle",
                messages: [],
                composerHasDraft: false,
                writeRefusal: null,
            };
            body.context.sessions = [initialTarget, openedTarget].map((target) => ({
                target,
                title: "Private sibling title",
                status: "idle",
            }));
            const controller = controllerSession({
                "Navigate now": {
                    action: { type: "desktopOpen", target: { kind: "session", ...openedTarget } },
                    reply: "Navigation completed.",
                },
                "Stage in the original conversation": {
                    action: {
                        type: "sessionSend",
                        target: initialTarget,
                        text: "Private sibling draft",
                    },
                    reply: "Staging request completed.",
                },
            });
            f.provider.session.mockImplementation(async () => controller.session);
            const call = await activeCall(f, body);
            call.speak("Navigate now");
            call.delegate("navigation");
            await expect.poll(() => call.actions().length).toBe(1);
            call.speak("Stage in the original conversation");
            call.delegate("staging");
            call.speak("Later speech");
            await expect.poll(() => call.transcripts().length).toBe(3);
            const [navigate, stage, later] = call.transcripts().map((frame) => frame.transcriptId);
            const updated = structuredClone(body.context);
            updated.activeTarget = { kind: "session", ...openedTarget };
            updated.activeSession!.target = openedTarget;
            call.binding.message(
                JSON.stringify({ type: "desktopContext", revision: 2, context: updated }),
            );
            await expect
                .poll(() => f.info.mock.calls.map((args) => JSON.parse(args.at(-1)!)))
                .toContainEqual(
                    expect.objectContaining({ event: "context.accepted", contextRevision: 2 }),
                );
            expect(call.actions()).toHaveLength(1);
            call.answer(call.actions()[0]!, { status: "succeeded", output: { type: "ack" } });
            await expect.poll(() => call.actions().length).toBe(2);
            const reopen = call.actions()[1]!;
            expect(reopen).toMatchObject({
                contextRevision: 2,
                inputTranscriptIds: [navigate, stage],
                action: { type: "desktopOpen", target: { kind: "session", ...initialTarget } },
            });
            call.binding.message(
                JSON.stringify({ type: "desktopContext", revision: 3, context: body.context }),
            );
            call.answer(reopen, { status: "succeeded", output: { type: "ack" } });
            await expect.poll(() => call.actions().length).toBe(3);
            const sendAction = call.actions()[2]!;
            expect(sendAction).toMatchObject({
                contextRevision: 3,
                inputTranscriptIds: [navigate, stage],
                action: {
                    type: "sessionSend",
                    target: initialTarget,
                    text: "Private sibling draft",
                },
            });
            expect(sendAction.inputTranscriptIds).not.toContain(later);
            const stagingInput = controller.requests
                .find((item) =>
                    JSON.stringify(item.context.messages.at(-1)).includes(
                        "Stage in the original conversation",
                    ),
                )!
                .context.messages.at(-1)!;
            const envelope = JSON.parse(
                (stagingInput.content as { type: "text"; text: string }[])[0]!.text,
            );
            expect(envelope.desktop.activeSession.target).toEqual(openedTarget);
            call.answer(
                sendAction,
                conflict
                    ? {
                          status: "refused",
                          code: "draftConflict",
                          message: "A draft is already present.",
                      }
                    : { status: "succeeded", output: { type: "staged" } },
            );
            await expect.poll(() => f.append.mock.calls.length).toBe(2);
            // A verified staging is answered with a fixed outcome; a refusal goes back to the controller.
            expect(f.append).toHaveBeenLastCalledWith({
                delegationId: "staging",
                text: `${
                    conflict
                        ? "Staging request completed."
                        : "Staged the message in Private sibling title. It has not been sent; the person must review it and press Send."
                }\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
                speakable: true,
            });
            expect(
                controller.requests.filter((item) =>
                    JSON.stringify(item).includes("Private sibling draft"),
                ),
            ).toHaveLength(conflict ? 1 : 0);
            if (conflict)
                expect(JSON.stringify(controller.requests.at(-1))).toContain("draftConflict");
            expect(call.actions()).toHaveLength(3);
            expect(f.provider.session).toHaveBeenCalledOnce();
            expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
        },
    );

    it.each([
        ["running", "idle"],
        ["waiting", "idle"],
        ["idle", "error"],
        ["idle", "awaitingInput"],
    ] as const)(
        "offers one attention notice for %s to %s, without treating initial idle as completion",
        async (before, after) => {
            const f = await fixture();
            const body = request();
            const target = {
                connectionId: "connection",
                groupId: "group",
                sessionId: "conversation",
            };
            body.context.activeSession = {
                target,
                status: "idle",
                messages: [],
                composerHasDraft: false,
                writeRefusal: null,
            };
            const call = await activeCall(f, body);
            const update = async (
                status: typeof before | typeof after,
                text = "Public result.",
            ) => {
                call.binding.message(
                    JSON.stringify({
                        type: "sessionUpdate",
                        target,
                        status,
                        messages: [{ id: "public-message", role: "assistant", text }],
                        truncated: false,
                    }),
                );
                await new Promise<void>((resolve) => setImmediate(resolve));
            };
            await update("idle");
            expect(f.append).not.toHaveBeenCalled();
            if (before !== "idle") {
                await update(before);
                expect(f.append).toHaveBeenLastCalledWith(
                    expect.objectContaining({ speakable: false }),
                );
            }
            await update(after);
            expect(f.append).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    delegationId: null,
                    speakable: true,
                }),
            );
            expect(JSON.parse(f.append.mock.calls.at(-1)![0].text)).toMatchObject({
                status: after,
                lastAssistantMessage: "Public result.",
            });
            const notices = f.append.mock.calls.length;
            await update(after, "A revised public message at the same status.");
            expect(f.append).toHaveBeenCalledTimes(notices);
        },
    );

    it("keeps streaming snapshots local and bounds status summaries even when appends are unavailable", async () => {
        const f = await fixture();
        const body = request();
        const target = { connectionId: "connection", groupId: "group", sessionId: "conversation" };
        body.context.activeSession = {
            target,
            status: "running",
            messages: [],
            composerHasDraft: false,
            writeRefusal: null,
        };
        await f.start(body);
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        for (let i = 0; i < 100; i++) {
            control.binding.message(
                JSON.stringify({
                    type: "sessionUpdate",
                    target,
                    status: "running",
                    messages: [{ id: "stream", role: "assistant", text: "x".repeat(i + 1) }],
                    truncated: false,
                }),
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(f.append).not.toHaveBeenCalled();
        f.append.mockRejectedValueOnce(new Error("Append queue is full"));
        control.binding.message(
            JSON.stringify({
                type: "sessionUpdate",
                target,
                status: "idle",
                messages: [{ id: "stream", role: "assistant", text: "x".repeat(16000) }],
                truncated: false,
            }),
        );
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(JSON.stringify(f.append.mock.calls[0]).length).toBeLessThan(2500);
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("active");
    });

    it.each([false, true])(
        "distinguishes unexpected controller loss from an already requested close (%s)",
        async (requested) => {
            const f = await fixture();
            await f.start();
            const control = await f.attach();
            f.calls[0]!.onEvent({ type: "ready" });
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe("active");
            if (requested) await f.live.close(f.db.context, "owner", "liveone");
            control.binding.closed();
            await expect
                .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
                .toBe(requested ? "closed" : "failed");
            if (!requested)
                expect((await f.live.get(f.db.context, "owner", "liveone")).error).toBe(
                    "The desktop controller disconnected.",
                );
        },
    );

    it("feeds fresh selected public snapshots to the controller without mutating accepted context revisions", async () => {
        const f = await fixture();
        const body = request();
        const target = { connectionId: "connection", groupId: "group", sessionId: "conversation" };
        body.context.activeSession = {
            target,
            status: "running",
            messages: [],
            composerHasDraft: false,
            writeRefusal: null,
        };
        await f.start(body);
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        control.binding.message(
            JSON.stringify({
                type: "sessionUpdate",
                target,
                status: "idle",
                messages: [{ id: "message", role: "assistant", text: "Fresh public completion" }],
                truncated: false,
            }),
        );
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        control.binding.message(
            JSON.stringify({ type: "desktopContext", revision: 1, context: body.context }),
        );
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "read-latest" });
        await expect.poll(() => f.inferenceRequests.length).toBe(1);
        const input = f.inferenceRequests[0] as SessionRunRequest;
        const content = input.context.messages.at(-1)!.content;
        if (!Array.isArray(content) || content[0]?.type !== "text")
            throw new Error("Missing request envelope");
        expect(JSON.parse(content[0].text).sessionUpdates).toMatchObject([{ status: "idle" }]);
        expect(JSON.stringify(f.inferenceRequests[0])).not.toContain("Fresh public completion");
        expect((await f.live.get(f.db.context, "owner", "liveone")).contextRevision).toBe(1);
    });
    it("returns SDP before provider readiness and exposes only typed call-local transcript IDs", async () => {
        const f = await fixture();
        await f.start();
        expect((await f.live.get(f.db.context, "owner", "liveone")).status).toBe("starting");
        const control = await f.attach();
        expect(control.frames.slice(0, 2)).toMatchObject([
            { type: "hello", windowId: "window-one", sessionId: "liveone", contextRevision: 1 },
            { type: "status", status: "starting" },
        ]);
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        f.calls[0]!.onEvent({ type: "transcript", role: "user", text: " the the " });
        await expect
            .poll(() => control.frames.filter((frame) => frame.type === "transcript"))
            .toHaveLength(1);
        expect(control.frames.at(-1)).toEqual({
            type: "transcript",
            role: "user",
            text: " the the ",
            transcriptId: expect.any(String),
        });
        expect(JSON.stringify(f.events)).not.toContain("v=fixture");
        expect(JSON.stringify(f.events)).not.toContain(" the the ");
    });

    it("isolates owners, duplicate IDs, one controller and one active call per window", async () => {
        const f = await fixture();
        await f.start();
        await expect(f.live.get(f.db.context, "other", "liveone")).rejects.toMatchObject({
            status: 404,
        });
        await expect(f.live.reserve(f.db.context, "owner", request())).rejects.toMatchObject({
            status: 409,
            session: { id: "liveone" },
        });
        await expect(f.live.reserve(f.db.context, "other", request())).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            f.live.reserve(f.db.context, "owner", request("livetwo")),
        ).rejects.toMatchObject({ status: 409 });
        await expect(f.attach("liveone", "owner", "foreign-window")).rejects.toMatchObject({
            status: 409,
        });
        await f.attach();
        await expect(f.attach()).rejects.toMatchObject({ status: 409 });
        expect(transport.create).toHaveBeenCalledTimes(1);
    });

    it("rolls reservation and events back with an outer transaction and never allocates", async () => {
        const f = await fixture();
        await expect(
            f.db.context.inTx(async (tx) => {
                await f.live.reserve(tx, "owner", request());
                expect(transport.create).not.toHaveBeenCalled();
                expect(f.events).toEqual([]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        await expect(f.live.get(f.db.context, "owner", "liveone")).rejects.toMatchObject({
            status: 404,
        });
        expect(f.events).toEqual([]);
        expect(transport.create).not.toHaveBeenCalled();
    });

    it("rejects conflicting same-revision context and does not start controller inference", async () => {
        const f = await fixture();
        await f.start();
        const control = await f.attach();
        control.binding.message(
            JSON.stringify({
                type: "desktopContext",
                revision: 1,
                context: { ...request().context, truncated: true },
            }),
        );
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("failed");
        expect(f.provider.session).not.toHaveBeenCalled();
    });

    it("keeps native deliberate closure separate from confirmed usage and makes close idempotent", async () => {
        const f = await fixture();
        await f.start();
        await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("active");
        await f.live.close(f.db.context, "owner", "liveone");
        await expect
            .poll(async () => (await f.live.get(f.db.context, "owner", "liveone")).status)
            .toBe("closed");
        expect(await f.live.close(f.db.context, "owner", "liveone")).toMatchObject({
            status: "closed",
            usage: { seconds: null, final: false },
        });
    });

    it("marks unfinished calls failed after restart without replaying allocation", async () => {
        const f = await fixture(false);
        await f.live.reserve(f.db.context, "owner", request());
        const restored = new LiveModule(f.config, new DurableFunctionsModule(), f.bots);
        await restored.beforeStart(f.db.context);
        expect(await restored.get(f.db.context, "owner", "liveone")).toMatchObject({
            status: "failed",
            usage: { seconds: null, final: false },
        });
        expect(transport.create).not.toHaveBeenCalled();
    });
});

const gardenNotes = { connectionId: "local", groupId: "garden", sessionId: "notes" };
const releaseNotes = { connectionId: "local", groupId: "garden", sessionId: "release" };
const allCapabilities = ["appState", "voiceFocus", "taskCreate", "sessionModelChange"];

function voiceState(
    focus = gardenNotes,
    text = "The requested changes are complete.",
): LiveAppState {
    return {
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
                                        target: gardenNotes,
                                        title: "Garden notes",
                                        status: "idle",
                                        lastActivityAt: null,
                                    },
                                    {
                                        target: releaseNotes,
                                        title: "Release notes",
                                        status: "idle",
                                        lastActivityAt: null,
                                    },
                                ],
                            },
                        ],
                    },
                ],
                models: [],
            },
        ],
        focused: {
            target: { kind: "session", ...focus },
            title: null,
            latestMessage: { state: "loaded", role: "assistant", text, truncated: false },
        },
        truncated: false,
    };
}

const voiceRequest = (capabilities = allCapabilities): CreateLiveSessionRequest => ({
    ...request(),
    desktopCapabilities: capabilities,
    appState: voiceState(),
});

describe("voice v2 desktop capabilities", () => {
    const status = async (f: Fixture, id = "liveone") =>
        (await f.live.get(f.db.context, "owner", id)).status;
    const controllerTools = (f: Fixture, index = 0) =>
        ((f.provider.session.mock.calls[index] as unknown[])[1] as SessionOptions).tools!.map(
            (tool) => tool.name,
        );

    it("negotiates capabilities, echoes them in hello, and starts voice with Markdown AppState", async () => {
        const f = await fixture();
        await f.start({
            ...voiceRequest(),
            desktopCapabilities: [
                "voiceFocus",
                "appState",
                "laterIdea",
                "sessionModelChange",
                "taskCreate",
            ],
        });
        const control = await f.attach();
        expect(control.frames[0]).toEqual({
            type: "hello",
            sessionId: "liveone",
            windowId: "window-one",
            contextRevision: 1,
            capabilities: allCapabilities,
        });
        expect(f.calls[0]!.instructions).toBe(LIVE_VOICE_INSTRUCTIONS);
        expect(f.calls[0]!.initialContext).toMatch(
            /^# Desktop AppState — \d{1,2}:\d{2} [AP]M\n\nFocused: This Mac \/ Observatory \/ Garden \/ Garden notes\n/u,
        );
        expect(f.calls[0]!.initialContext).toContain(
            "## Focused conversation: Garden notes\nLatest loaded message (assistant):\n> The requested changes are complete.",
        );
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        f.calls[0]!.onEvent({ type: "delegation", delegationId: "tools" });
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        expect(controllerTools(f)).toEqual([
            "desktopState",
            "desktopOpen",
            "sessionRead",
            "sessionSend",
            "sessionWatch",
            "composerDraftAppend",
            "taskCreate",
            "sessionModelChange",
        ]);
    });

    it("keeps the original contract for desktops that negotiate nothing and refuses unnegotiated AppState", async () => {
        const f = await fixture();
        await expect(
            f.live.reserve(f.db.context, "owner", { ...request(), appState: voiceState() }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            f.live.reserve(f.db.context, "owner", {
                ...request(),
                desktopCapabilities: ["voiceFocus"],
                context: {
                    ...request().context,
                    activeTarget: {
                        kind: "task",
                        connectionId: "local",
                        groupId: "task-group",
                        sessionId: "task-session",
                        taskId: "task",
                    },
                },
            }),
        ).rejects.toMatchObject({ status: 400 });
        await f.start();
        const original = await f.attach();
        expect(original.frames[0]).not.toHaveProperty("capabilities");
        await f.start({
            ...request("livetwo", "window-two"),
            desktopCapabilities: ["taskCreate", "sessionModelChange", "voiceFocus"],
        });
        const control = await f.attach("livetwo", "owner", "window-two");
        expect(control.frames[0]).toMatchObject({ type: "hello", capabilities: ["voiceFocus"] });
        f.calls[1]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f, "livetwo")).toBe("active");
        f.calls[1]!.onEvent({ type: "delegation", delegationId: "tools" });
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        expect(controllerTools(f)).toEqual([
            "desktopState",
            "desktopOpen",
            "sessionRead",
            "sessionSend",
            "sessionWatch",
            "composerDraftAppend",
        ]);
        control.binding.message(JSON.stringify({ type: "appState", appState: voiceState() }));
        await expect.poll(() => status(f, "livetwo")).toBe("failed");
    });

    it("pushes a focus change with its latest message as quiet appends split without truncation", async () => {
        const f = await fixture();
        await f.start(voiceRequest());
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        vi.useFakeTimers();
        const changed = JSON.stringify({
            type: "appState",
            appState: voiceState(releaseNotes, "Release checklist line. ".repeat(30).trim()),
        });
        control.binding.message(changed);
        await vi.advanceTimersByTimeAsync(251);
        const appends = f.append.mock.calls.map(([input]) => input);
        expect(appends.length).toBeGreaterThan(1);
        for (const [index, input] of appends.entries()) {
            expect(input).toMatchObject({ delegationId: null, speakable: false });
            expect(Buffer.byteLength(input.text)).toBeLessThanOrEqual(500);
            expect(input.text).toMatch(
                new RegExp(
                    `^# Desktop AppState update — .+ \\(part ${index + 1} of ${appends.length}\\)\\n`,
                    "u",
                ),
            );
        }
        const body = appends
            .map((input) => input.text.slice(input.text.indexOf("\n") + 1))
            .join("\n");
        expect(body).toContain("Focused: This Mac / Observatory / Garden / Release notes");
        expect(body).toContain(
            "## Focused conversation: Release notes\nLatest loaded message (assistant):\n> Release checklist line.",
        );
        control.binding.message(changed);
        await vi.advanceTimersByTimeAsync(251);
        expect(f.append).toHaveBeenCalledTimes(appends.length);
    });

    it("holds background AppState until the outcome is delivered and highlights the target before acting", async () => {
        const f = await fixture();
        const controller = controllerSession({
            "Open release notes": {
                action: { type: "desktopOpen", target: { kind: "session", ...releaseNotes } },
                reply: "This reply is never requested.",
            },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        await f.start(voiceRequest());
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        f.calls[0]!.onEvent({
            type: "delegation",
            delegationId: "open",
            text: "Open release notes",
        });
        const actions = () =>
            control.frames.filter(
                (frame): frame is ActionFrame => frame.type === "actionRequested",
            );
        await expect.poll(() => actions().length).toBe(1);
        const focus = () => control.frames.filter((frame) => frame.type === "voiceFocus");
        expect(focus()).toMatchObject([
            { target: { kind: "session", ...releaseNotes }, reason: "mention", contextRevision: 1 },
            {
                target: { kind: "session", ...releaseNotes },
                reason: "navigation",
                contextRevision: 1,
            },
        ]);
        const order = control.frames.map((frame) => frame.type);
        expect(order.lastIndexOf("voiceFocus")).toBeLessThan(order.indexOf("actionRequested"));
        // The desktop navigates, so its AppState changes while the request still awaits its result.
        control.binding.message(
            JSON.stringify({ type: "appState", appState: voiceState(releaseNotes, "Ship it.") }),
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(f.append).not.toHaveBeenCalled();
        control.binding.message(
            JSON.stringify({
                type: "actionResult",
                actionId: actions()[0]!.actionId,
                result: { status: "succeeded", output: { type: "ack" } },
            }),
        );
        await expect.poll(() => f.append.mock.calls.length).toBe(2);
        expect(f.append.mock.calls[0]![0]).toEqual({
            delegationId: "open",
            text: `Opened Release notes.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
            speakable: true,
        });
        expect(f.append.mock.calls[1]![0]).toMatchObject({
            delegationId: null,
            speakable: false,
            text: expect.stringContaining(
                "Focused: This Mac / Observatory / Garden / Release notes",
            ),
        });
        expect(f.append.mock.calls[1]![0].text).toContain("> Ship it.");
        expect(focus().at(-1)).toMatchObject({ target: null });
        expect(controller.requests).toHaveLength(1);
    });

    it("keeps a queued request's focus and action until the previous outcome is delivered", async () => {
        const f = await fixture();
        const controller = controllerSession({
            "Open release notes": {
                action: { type: "desktopOpen", target: { kind: "session", ...releaseNotes } },
                reply: "This reply is never requested.",
            },
            "Open garden notes": {
                action: { type: "desktopOpen", target: { kind: "session", ...gardenNotes } },
                reply: "This reply is never requested.",
            },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        let deliver!: () => void;
        const delivered = new Promise<void>((resolve) => (deliver = resolve));
        f.append.mockImplementation(async (input) => {
            if (input.delegationId === "first") await delivered;
        });
        await f.start(voiceRequest());
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        const actions = () =>
            control.frames.filter(
                (frame): frame is ActionFrame => frame.type === "actionRequested",
            );
        const answer = (frame: ActionFrame) =>
            control.binding.message(
                JSON.stringify({
                    type: "actionResult",
                    actionId: frame.actionId,
                    result: { status: "succeeded", output: { type: "ack" } },
                }),
            );
        const focus = () =>
            control.frames.flatMap((frame) =>
                frame.type === "voiceFocus"
                    ? [frame.target === null ? "clear" : `${frame.reason}:${frame.target.kind}`]
                    : [],
            );
        f.calls[0]!.onEvent({
            type: "delegation",
            delegationId: "first",
            text: "Open release notes",
        });
        await expect.poll(() => actions().length).toBe(1);
        answer(actions()[0]!);
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        f.calls[0]!.onEvent({
            type: "delegation",
            delegationId: "second",
            text: "Open garden notes",
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The first outcome is still being appended, so the queued request has not started.
        expect(actions()).toHaveLength(1);
        expect(controller.requests).toHaveLength(1);
        expect(focus()).toEqual(["mention:session", "navigation:session"]);
        deliver();
        await expect.poll(() => actions().length).toBe(2);
        expect(actions()[1]!.action).toEqual({
            type: "desktopOpen",
            target: { kind: "session", ...gardenNotes },
        });
        // The first request cleared its own highlight before the queued one highlighted its target.
        expect(focus()).toEqual([
            "mention:session",
            "navigation:session",
            "clear",
            "mention:session",
            "navigation:session",
        ]);
        answer(actions()[1]!);
        await expect
            .poll(() => f.append.mock.calls.map(([input]) => input.delegationId))
            .toContain("second");
        await expect.poll(() => focus().at(-1)).toBe("clear");
        expect(focus()).toHaveLength(6);
    });

    const focusedOn = (target: typeof gardenNotes): CreateLiveSessionRequest["context"] => ({
        ...request().context,
        activeTarget: { kind: "session", ...target },
        sessions: [gardenNotes, releaseNotes].map((session) => ({
            target: session,
            title: session === gardenNotes ? "Garden notes" : "Release notes",
            status: "idle" as const,
        })),
        activeSession: {
            target,
            status: "idle",
            messages: [],
            composerHasDraft: false,
            writeRefusal: null,
        },
    });

    async function writeCall(step: ControllerStep) {
        const f = await fixture();
        const controller = controllerSession({ "Put it in release notes": step });
        f.provider.session.mockImplementation(async () => controller.session);
        await f.start({ ...voiceRequest(), context: focusedOn(gardenNotes) });
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        f.calls[0]!.onEvent({
            type: "delegation",
            delegationId: "write",
            text: "Put it in release notes",
        });
        const actions = () =>
            control.frames.filter(
                (frame): frame is ActionFrame => frame.type === "actionRequested",
            );
        const answer = (frame: ActionFrame, result: unknown) =>
            control.binding.message(
                JSON.stringify({ type: "actionResult", actionId: frame.actionId, result }),
            );
        return { f, control, controller, actions, answer };
    }

    it.each([
        [
            { type: "sessionSend", target: releaseNotes, text: "Ship it." },
            { type: "staged" },
            "Staged the message in Release notes. It has not been sent; the person must review it and press Send.",
        ],
        [
            { type: "composerDraftAppend", target: releaseNotes, text: "Ship it." },
            { type: "ack" },
            "Added the text to the draft in Release notes. Nothing was sent.",
        ],
    ] as const)(
        "opens an off-screen conversation before %j and reports only the verified result",
        async (action, output, spoken) => {
            const { f, control, controller, actions, answer } = await writeCall({
                action,
                reply: "This reply is never requested.",
            });
            await expect.poll(() => actions().length).toBe(1);
            expect(actions()[0]).toMatchObject({
                contextRevision: 1,
                action: { type: "desktopOpen", target: { kind: "session", ...releaseNotes } },
            });
            const order = control.frames.map((frame) =>
                frame.type === "voiceFocus" ? `focus:${frame.reason}` : frame.type,
            );
            expect(order.lastIndexOf("focus:navigation")).toBeLessThan(
                order.indexOf("actionRequested"),
            );
            // The desktop navigates: its new context precedes the open's result.
            control.binding.message(
                JSON.stringify({
                    type: "desktopContext",
                    revision: 2,
                    context: focusedOn(releaseNotes),
                }),
            );
            answer(actions()[0]!, { status: "succeeded", output: { type: "ack" } });
            await expect.poll(() => actions().length).toBe(2);
            expect(actions()[1]).toMatchObject({ contextRevision: 2, action });
            answer(actions()[1]!, { status: "succeeded", output });
            await expect.poll(() => f.append.mock.calls.length).toBeGreaterThan(0);
            expect(f.append.mock.calls[0]![0]).toEqual({
                delegationId: "write",
                text: `${spoken}\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
                speakable: true,
            });
            expect(controller.requests).toHaveLength(1);
        },
    );

    it("stages straight into the focused conversation without opening it again", async () => {
        const { f, actions, answer } = await writeCall({
            action: { type: "sessionSend", target: gardenNotes, text: "Ship it." },
            reply: "This reply is never requested.",
        });
        await expect.poll(() => actions().length).toBe(1);
        expect(actions()[0]).toMatchObject({
            action: { type: "sessionSend", target: gardenNotes, text: "Ship it." },
        });
        answer(actions()[0]!, { status: "succeeded", output: { type: "staged" } });
        await expect.poll(() => f.append.mock.calls.length).toBeGreaterThan(0);
        expect(f.append.mock.calls[0]![0].text).toBe(
            `Staged the message in Garden notes. It has not been sent; the person must review it and press Send.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
        );
        expect(actions()).toHaveLength(1);
    });

    it("never stages or claims staging when the off-screen conversation cannot be opened", async () => {
        const { f, controller, actions, answer } = await writeCall({
            action: { type: "sessionSend", target: releaseNotes, text: "Ship it." },
            reply: "Release notes could not be opened, so nothing was staged.",
        });
        await expect.poll(() => actions().length).toBe(1);
        expect(actions()[0]!.action.type).toBe("desktopOpen");
        answer(actions()[0]!, {
            status: "refused",
            code: "notFound",
            message: "That conversation is no longer available.",
        });
        await expect.poll(() => f.append.mock.calls.length).toBeGreaterThan(0);
        expect(f.append.mock.calls[0]![0].text).toBe(
            `Release notes could not be opened, so nothing was staged.\n\n${LIVE_LATER_REQUEST_INSTRUCTIONS}`,
        );
        expect(actions()).toHaveLength(1);
        expect(JSON.stringify(controller.requests.at(-1))).toContain(
            "That conversation is no longer available.",
        );
    });

    it("pushes a complete AppState again after ten minutes without one", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const f = await fixture();
        await f.start(voiceRequest());
        await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        expect(f.append).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000 + 300);
        expect(f.append).toHaveBeenCalledOnce();
        expect(f.append.mock.calls[0]![0].text).toMatch(
            /^# Desktop AppState — .+\nFocused: This Mac \/ Observatory \/ Garden \/ Garden notes\n\n## This Mac \(local\)\n/u,
        );
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        expect(f.append).toHaveBeenCalledOnce();
    });

    const body = (text: string) => text.slice(text.indexOf("\n") + 1);

    it("bounds only the startup AppState; the ten-minute snapshot is split and keeps every entry", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const f = await fixture();
        const crowded = voiceState();
        const long = (prefix: string, count: number) =>
            Array.from({ length: count }, (_, index) => ({
                target: { ...gardenNotes, sessionId: `${prefix}${index}` },
                title: `A conversation with a deliberately long ${prefix} name ${index}`,
                status: "idle" as const,
                lastActivityAt: null,
            }));
        const project = crowded.servers[0]!.projects[0]!;
        project.sessions = long("root", 100);
        project.workspaces[0]!.sessions.push(...long("garden", 98));
        await f.start({ ...voiceRequest(), appState: crowded });
        await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        expect(f.calls[0]!.initialContext).toMatch(/more entries omitted \(truncated\)/u);
        await vi.advanceTimersByTimeAsync(10 * 60_000 + 300);
        const parts = f.append.mock.calls.map(([input]) => input);
        expect(parts.length).toBeGreaterThan(16);
        for (const part of parts) {
            expect(part).toMatchObject({ delegationId: null, speakable: false });
            expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(500);
        }
        const snapshot = parts.map((part) => body(part.text)).join("\n");
        expect(snapshot).not.toContain("omitted");
        expect(snapshot).toContain("deliberately long root name 99 — Idle");
        expect(snapshot).toContain("deliberately long garden name 97 — Idle");
    });

    it("pushes a failed AppState change again after a bounded backoff instead of counting it as told", async () => {
        const f = await fixture();
        await f.start(voiceRequest());
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        vi.useFakeTimers();
        f.append.mockRejectedValueOnce(new Error("The append failed."));
        control.binding.message(
            JSON.stringify({ type: "appState", appState: voiceState(releaseNotes, "Ship it.") }),
        );
        await vi.advanceTimersByTimeAsync(251);
        expect(f.append).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(900);
        expect(f.append).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(200);
        expect(f.append).toHaveBeenCalledTimes(2);
        const [failed, retried] = f.append.mock.calls.map(([input]) => input.text);
        expect(body(retried!)).toBe(body(failed!));
        expect(retried).toContain("Focused: This Mac / Observatory / Garden / Release notes");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(f.append).toHaveBeenCalledTimes(2);
    });

    it("holds the rest of a split AppState push when a request starts between its parts", async () => {
        const f = await fixture();
        let finish!: () => void;
        const controller = controllerSession({
            "between-request": {
                reply: "Done between parts.",
                gate: new Promise<void>((resolve) => (finish = resolve)),
            },
        });
        f.provider.session.mockImplementation(async () => controller.session);
        await f.start(voiceRequest());
        const control = await f.attach();
        f.calls[0]!.onEvent({ type: "ready" });
        await expect.poll(() => status(f)).toBe("active");
        let release!: () => void;
        f.append.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
        control.binding.message(
            JSON.stringify({
                type: "appState",
                appState: voiceState(releaseNotes, "Release checklist line. ".repeat(30).trim()),
            }),
        );
        await expect.poll(() => f.append.mock.calls.length).toBe(1);
        const parts = Number(/\(part 1 of (\d+)\)/u.exec(f.append.mock.calls[0]![0].text)![1]);
        expect(parts).toBeGreaterThan(1);
        f.calls[0]!.onEvent({
            type: "delegation",
            delegationId: "between",
            text: "between-request",
        });
        await expect.poll(() => controller.requests.length).toBe(1);
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The request is still running, so the remaining parts wait.
        expect(f.append).toHaveBeenCalledOnce();
        finish();
        await expect.poll(() => f.append.mock.calls.length).toBe(2 + parts);
        const appends = f.append.mock.calls.map(([input]) => input);
        expect(appends.map((input) => input.delegationId)).toEqual([
            null,
            "between",
            ...Array.from({ length: parts }, () => null),
        ]);
        // Partial background delivery is repaired with a complete snapshot after the outcome.
        expect(appends[2]!.text).toContain(`(part 1 of ${parts})`);
        expect(appends[2]!.text).toContain("# Desktop AppState —");
        expect(appends[2]!.text).toContain("## This Mac (local)");
        expect(
            appends
                .slice(2)
                .map((input) => body(input.text))
                .join("\n"),
        ).toContain("Release checklist line.");
    });

    it("restores the complete AppState after a middle part fails even when state returns to the baseline", async () => {
        const f = await fixture();
        const call = await activeCall(f, voiceRequest());
        vi.useFakeTimers();
        f.append.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Lost part"));
        call.binding.message(
            JSON.stringify({
                type: "appState",
                appState: voiceState(releaseNotes, "Release checklist line. ".repeat(30).trim()),
            }),
        );
        await vi.advanceTimersByTimeAsync(250);
        expect(f.append).toHaveBeenCalledTimes(2);
        call.binding.message(JSON.stringify({ type: "appState", appState: voiceState() }));
        await vi.advanceTimersByTimeAsync(999);
        expect(f.append).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.append).toHaveBeenCalledTimes(3);
        expect(f.append.mock.calls[2]![0]).toMatchObject({
            delegationId: null,
            speakable: false,
            text: expect.stringMatching(/^# Desktop AppState —/u),
        });
        expect(f.append.mock.calls[2]![0].text).toContain("Garden notes");
        expect(f.append.mock.calls[2]![0].text).not.toContain("Release checklist line");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(f.append).toHaveBeenCalledTimes(3);
    });

    it("starts with the stored voice prompt and runs the controller on its frozen effort and tier", async () => {
        const f = await fixture();
        (f.config as unknown as { voiceSettings: object }).voiceSettings = {
            system_prompt: "Speak like a lighthouse keeper.",
        };
        const route = await f.config.liveControllerRoute();
        vi.mocked(f.config.liveControllerRoute).mockResolvedValueOnce({
            ...route,
            effort: "medium",
            serviceTier: "priority",
        });
        const call = await activeCall(f);
        expect(f.calls[0]!.instructions).toBe("Speak like a lighthouse keeper.");
        call.delegate("tier");
        await expect.poll(() => f.inferenceRequests.length).toBe(1);
        expect(f.inferenceRequests[0]).toMatchObject({ effort: "medium", serviceTier: "priority" });
    });

    it("reports and changes voice settings through configuration and active-admin tools", async () => {
        const f = await fixture();
        const config = f.config as unknown as Record<string, unknown>;
        config.voiceSettings = {
            controller_model: "anthropic/sonnet-5",
            controller_fast_mode: true,
        };
        config.voiceController = vi.fn(() => ({
            providerId: "claude",
            modelId: "anthropic/sonnet-5",
            model: undefined,
            effort: "low",
            serviceTier: null,
            notice: "Fast mode is not available for Sonnet 5, so it is ignored.",
        }));
        const update = vi.fn(async (_ctx: unknown, _update: unknown) => true);
        config.updateRuntimeVoiceSettings = update;
        const changed = vi.fn();
        f.live.onSettingsUpdated(changed);
        expect(f.live.voiceSettings()).toEqual({
            controller: {
                providerId: null,
                modelId: "anthropic/sonnet-5",
                effort: null,
                fastMode: true,
            },
            effectiveController: {
                providerId: "claude",
                modelId: "anthropic/sonnet-5",
                effort: "low",
                serviceTier: null,
                notice: "Fast mode is not available for Sonnet 5, so it is ignored.",
            },
            defaultSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
            systemPromptOverride: null,
            effectiveSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        await f.live.updateVoiceSettings(f.db.context, {
            controller: { providerId: null, fastMode: false },
            systemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        expect(update).toHaveBeenLastCalledWith(expect.anything(), {
            controller_provider: null,
            controller_fast_mode: false,
            system_prompt: null,
        });
        expect(changed).toHaveBeenCalledOnce();
        update.mockResolvedValueOnce(false);
        await f.live.updateVoiceSettings(f.db.context, { systemPrompt: "Be brief." });
        expect(update).toHaveBeenLastCalledWith(expect.anything(), { system_prompt: "Be brief." });
        expect(changed).toHaveBeenCalledOnce();
        await expect(
            f.live.updateVoiceSettings(f.db.context, { systemPrompt: "   " }),
        ).rejects.toBeInstanceOf(VoiceSettingsError);

        const scope = { agent: { id: "admin-agent" } } as never;
        expect(await f.liveHooks.tools!(f.db.context, scope)).toEqual([]);
        const forAgent = vi.mocked(f.bots.forAgent);
        forAgent.mockResolvedValue({ isAdmin: true, status: "active" } as never);
        const tools = await f.liveHooks.tools!(f.db.context, scope);
        expect(tools.map((tool) => tool.name)).toEqual([
            "get_voice_settings",
            "set_voice_settings",
        ]);
        const [get, set] = tools;
        expect(get!.requiresAutoOrFullAccess).toBeUndefined();
        expect(set!.requiresAutoOrFullAccess).toBe(true);
        await expect(get!.execute(f.db.context, {}, {} as never)).resolves.toMatchObject({
            defaultSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
        });
        forAgent.mockResolvedValue({ isAdmin: true, status: "archived" } as never);
        await expect(
            set!.execute(f.db.context, { systemPrompt: "Be brief." }, {} as never),
        ).rejects.toThrow("Only an active admin bot can read or change voice settings.");
        expect(update).toHaveBeenCalledTimes(2);
    });
});
