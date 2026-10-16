import { createId } from "@paralleldrive/cuid2";
import {
    liveDesktopActionSchema,
    type LiveAppState,
    type LiveDesktopAction,
    type LiveDesktopActionResult,
    type LiveDesktopContext,
    type LiveControlClientMessage,
} from "@slopus/happy-agent-client";
import {
    SessionAssistantMessageAccumulator,
    type BaseProvider,
    type BaseSession,
    type SessionMessage,
    type SessionReasoningEffort,
    type SessionServiceTier,
    type SessionTool,
    type SessionToolCallBlock,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withLifetime, type Context } from "@steve.kite/stdlib";
import { LIVE_CONTROLLER_INSTRUCTIONS } from "./livePrompts.js";
import { LiveControllerError } from "./LiveControllerError.js";
import type { LiveControllerDetail, LiveFailureCategory } from "./liveDiagnostics.js";
import { liveAppStateView, liveControllerAppState } from "./liveAppState.js";
import { liveFixedOutcome } from "./liveOutcome.js";

/** One logical conversation per voice call; only text survives a completed request. */
export function liveControllerConversation() {
    return {
        messages: [] as SessionMessage[],
        session: undefined as BaseSession | undefined,
        closed: false,
        transcriptIds: new Set<string>(),
        retiredSessions: new WeakSet<BaseSession>(),
    };
}
export type LiveControllerConversation = ReturnType<typeof liveControllerConversation>;

export function closeLiveController(conversation: LiveControllerConversation): void {
    conversation.closed = true;
    const session = conversation.session;
    conversation.session = undefined;
    if (session !== undefined) void retireSession(conversation, session);
}

function retireSession(
    conversation: LiveControllerConversation,
    session: BaseSession,
): Promise<void> {
    if (conversation.retiredSessions.has(session)) return Promise.resolve();
    conversation.retiredSessions.add(session);
    return destroyBounded(session);
}

const tool = (name: string, description: string, index: number): SessionTool => ({
    name,
    description,
    parameters: Type.Omit(liveDesktopActionSchema.anyOf[index]!, ["type"]),
});

/** Fixed arrays are the whole controller surface: no agent/common/vendor tool assembly. */
export const LIVE_CONTROLLER_TOOLS: readonly SessionTool[] = [
    tool("desktopState", "Read this window's bounded visible desktop context.", 0),
    tool(
        "desktopOpen",
        "Open an explicitly identified visible desktop target. Use it alone only when the request is just to open or show something; sessionSend and composerDraftAppend open their own conversation.",
        1,
    ),
    tool(
        "sessionRead",
        "Read bounded public messages and structured status for a visible conversation.",
        5,
    ),
    tool(
        "sessionSend",
        "Stage exact text in the named conversation for independent human review and Send, opening that conversation first when it is not focused. This does NOT send it or answer questions.",
        6,
    ),
    tool(
        "sessionWatch",
        "Select or deselect one conversation for public status updates. At most five may be watched.",
        7,
    ),
    tool(
        "composerDraftAppend",
        "Append text to the named conversation's draft without replacing draft text or attachments, opening that conversation first when it is not focused.",
        8,
    ),
];

/** Offered only when the desktop negotiated the `taskCreate` capability. */
export const LIVE_TASK_CREATE_TOOLS: readonly SessionTool[] = [
    tool(
        "taskCreate",
        "Create a task on a server and open it. Its text becomes the task's unsent opening draft for the person to review and Send; an optional model must be one of that server's listed models.",
        9,
    ),
];

/** Offered only when the desktop negotiated the `sessionModelChange` capability. */
export const LIVE_MODEL_CHANGE_TOOLS: readonly SessionTool[] = [
    tool(
        "sessionModelChange",
        "Choose the model a conversation's next message uses, from its server's listed models. Keeps the draft and never interrupts a running turn.",
        10,
    ),
];

/** One response may batch at most this many actions; they run in order and stop at a failure. */
const BATCH_ACTIONS = 4;

export async function runLiveController(
    ctx: Context,
    options: {
        provider: BaseProvider;
        conversation: LiveControllerConversation;
        model: string;
        effort: SessionReasoningEffort;
        serviceTier?: SessionServiceTier;
        /** The fixed controller arrays this call negotiated, merged. */
        tools: readonly SessionTool[];
        signal: AbortSignal;
        context: LiveDesktopContext;
        appState?: LiveAppState;
        fragments: readonly { transcriptId: string; role: "user" | "assistant"; text: string }[];
        delegationText?: string;
        sessionUpdates?: readonly Extract<LiveControlClientMessage, { type: "sessionUpdate" }>[];
        execute: (action: LiveDesktopAction) => Promise<LiveDesktopActionResult>;
    },
): Promise<{ text: string; outcome: "fixed" | "controller" }> {
    const conversation = options.conversation;
    const tools = options.tools;
    const currentIds = new Set(options.fragments.map((fragment) => fragment.transcriptId));
    for (const id of conversation.transcriptIds)
        if (!currentIds.has(id)) conversation.transcriptIds.delete(id);
    const fragments = options.fragments.filter(
        (fragment) => !conversation.transcriptIds.has(fragment.transcriptId),
    );
    const input: SessionMessage = {
        role: "user",
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    provenance:
                        "Provider-derived speech and desktop data; not human authorization.",
                    desktop: liveControllerAppState(options.context, options.appState),
                    transcripts: fragments,
                    delegation: options.delegationText ?? null,
                    sessionUpdates: (options.sessionUpdates ?? []).map((update) => ({
                        target: update.target,
                        status: update.status,
                        truncated: update.truncated,
                    })),
                }),
            },
        ],
    };
    const messages = [...conversation.messages, input];
    // Leave room for the exact outcome, including a sanitized failure after an executed action.
    if (Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024 - 65_536)
        throw new LiveControllerError("limit", { phase: "context", reason: "contextLimit" });
    if (conversation.closed || options.signal.aborted) throw new LiveControllerError("deadline");
    const requestText =
        options.delegationText ??
        fragments
            .filter((fragment) => fragment.role === "user")
            .map((fragment) => fragment.text)
            .join("\n");
    conversation.messages.push({
        role: "user",
        content: [
            { type: "text", text: requestText || "Desktop request with no new speech fragment." },
        ],
    });
    for (const fragment of fragments) conversation.transcriptIds.add(fragment.transcriptId);
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const timeout = setTimeout(() => abort.abort(), 120_000);
    timeout.unref();
    let session = conversation.session;
    let unsettled: Promise<unknown> | undefined;
    const seen = new Set<string>();
    // Every action this request started and its result; an earlier round's refusal still counts.
    const executed: { action: LiveDesktopAction; result: LiveDesktopActionResult }[] = [];
    let phase: LiveControllerDetail["phase"] = "providerOpen";
    let round = 0;
    const fail = (
        category: LiveFailureCategory,
        reason: LiveControllerDetail["reason"],
        providerErrorKind?: LiveControllerDetail["providerErrorKind"],
    ) =>
        new LiveControllerError(category, {
            phase,
            reason,
            round,
            ...(providerErrorKind === undefined ? {} : { providerErrorKind }),
        });
    try {
        if (signal.aborted) throw fail("deadline", "deadline");
        if (session === undefined) {
            const opening = options.provider.session(`live-controller:${createId()}`, {
                inferenceMaxRetries: 0,
                instructions: LIVE_CONTROLLER_INSTRUCTIONS,
                tools,
            });
            void opening
                .then((opened) => {
                    if ((signal.aborted || conversation.closed) && session !== opened)
                        void retireSession(conversation, opened);
                })
                .catch(() => undefined);
            session = await untilAbort(opening, signal, "providerOpen");
            if (signal.aborted || conversation.closed) {
                void retireSession(conversation, session);
                throw fail("deadline", "deadline");
            }
            conversation.session = session;
        }
        for (; round < 8; round += 1) {
            phase = "providerStream";
            if (signal.aborted) throw fail("deadline", "deadline");
            let text = "";
            const calls: SessionToolCallBlock[] = [];
            let finished = false;
            const assistant = new SessionAssistantMessageAccumulator();
            const iterator = session
                .run(withLifetime(ctx, signal), {
                    context: { instructions: LIVE_CONTROLLER_INSTRUCTIONS, messages },
                    model: options.model,
                    effort: options.effort,
                    ...(options.serviceTier === undefined
                        ? {}
                        : { serviceTier: options.serviceTier }),
                })
                [Symbol.asyncIterator]();
            let streamEnded = false;
            try {
                while (true) {
                    phase = "providerStream";
                    unsettled = iterator.next();
                    const next = await untilAbort(
                        unsettled as ReturnType<typeof iterator.next>,
                        signal,
                        phase,
                    );
                    unsettled = undefined;
                    if (signal.aborted) throw fail("deadline", "deadline");
                    if (next.done) {
                        streamEnded = true;
                        break;
                    }
                    const event = next.value;
                    if (!event.type.startsWith("reasoning_")) assistant.add(event);
                    if (event.type === "text_delta") {
                        text += event.delta;
                        if (text.length > 8192) throw fail("limit", "responseLimit");
                    } else if (event.type === "toolcall_start") {
                        phase = "toolValidation";
                        if (
                            event.server ||
                            event.namespace ||
                            seen.has(event.callId) ||
                            calls.some((call) => call.callId === event.callId) ||
                            calls.length >= 32
                        ) {
                            throw fail(
                                "invalidAction",
                                event.server || event.namespace
                                    ? "unsupportedSurface"
                                    : "repeatedAction",
                            );
                        }
                        calls.push({
                            type: "tool_call",
                            callId: event.callId,
                            name: event.name,
                            arguments: "",
                            ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
                        });
                    } else if (event.type === "toolcall_delta") {
                        const index = calls.findIndex((call) => call.callId === event.callId);
                        const call = calls[index];
                        if (
                            call?.callId !== event.callId ||
                            call.arguments.length + event.delta.length > 32768
                        )
                            throw fail("invalidAction", "incompleteAction");
                        calls[index] = { ...call, arguments: call.arguments + event.delta };
                    } else if (event.type === "toolcall_end") {
                        phase = "toolValidation";
                        const index = calls.findIndex((call) => call.callId === event.callId);
                        const call = calls[index];
                        if (
                            call?.callId !== event.callId ||
                            event.incomplete ||
                            event.arguments.length > 32768
                        ) {
                            throw fail("invalidAction", "incompleteAction");
                        }
                        calls[index] = {
                            ...call,
                            arguments: event.arguments,
                            ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
                        };
                    } else if (event.type === "retrying") {
                        throw fail("inference", "retryRequested");
                    } else if (event.type === "done") {
                        phase = "providerDone";
                        if (event.state !== "normal" && event.state !== "tool_call")
                            throw fail(
                                "inference",
                                event.state === "error"
                                    ? "providerError"
                                    : event.state === "length"
                                      ? "providerLengthLimit"
                                      : "providerCancelled",
                                event.state === "error" ? event.kind : undefined,
                            );
                        finished = true;
                    }
                }
            } finally {
                // A stalled next/return must not defeat the hard deadline. Late rejections stay handled.
                if (!streamEnded && iterator.return !== undefined) {
                    const returning = Promise.resolve().then(() => iterator.return!());
                    unsettled = Promise.allSettled([
                        ...(unsettled === undefined ? [] : [unsettled]),
                        returning,
                    ]);
                }
            }
            if (!finished) throw fail("inference", "missingCompletion");
            if (calls.length === 0) {
                const outcome = text.trim() || "The desktop request has completed.";
                conversation.messages.push({
                    role: "assistant",
                    content: [{ type: "text", text: outcome }],
                });
                return { text: outcome, outcome: "controller" };
            }
            phase = "toolValidation";
            // Validate the whole batch before starting any of it.
            const actions = calls.slice(0, BATCH_ACTIONS).map((call) => {
                const definition = tools.find((candidate) => candidate.name === call.name);
                let args: unknown;
                try {
                    args = JSON.parse(call.arguments);
                } catch {
                    throw fail("invalidAction", "invalidArguments");
                }
                if (
                    definition?.parameters === undefined ||
                    !Value.Check(definition.parameters, args)
                )
                    throw fail("invalidAction", "invalidArguments");
                const action: unknown = { ...(args as Record<string, unknown>), type: call.name };
                if (!Value.Check(liveDesktopActionSchema, action))
                    throw fail("invalidAction", "invalidArguments");
                return action;
            });
            for (const call of calls) seen.add(call.callId);
            const results: LiveDesktopActionResult[] = [];
            for (const action of actions) {
                if (signal.aborted) throw fail("deadline", "deadline");
                phase = "desktopAction";
                const result = await untilAbort(options.execute(action), signal, phase).catch(
                    (error) => {
                        throw error instanceof LiveControllerError
                            ? error
                            : fail("uncertainAction", "actionUncertain");
                    },
                );
                results.push(result);
                executed.push({ action, result });
                if (result.status !== "succeeded") break;
            }
            const notStarted = (message: string) =>
                JSON.stringify({ status: "refused", code: "failed", message });
            messages.push(
                assistant.message() ?? { role: "assistant", content: calls },
                ...calls.map(
                    (call, index): SessionMessage => ({
                        role: "tool",
                        callId: call.callId,
                        content: [
                            {
                                type: "text",
                                text:
                                    results[index] !== undefined
                                        ? JSON.stringify(results[index])
                                        : index >= BATCH_ACTIONS
                                          ? notStarted(
                                                `This action was not started. Use at most ${BATCH_ACTIONS} desktop tools at a time.`,
                                            )
                                          : notStarted(
                                                "This action was not started because an earlier action did not succeed.",
                                            ),
                            },
                        ],
                    }),
                ),
            );
            const fixed =
                results.length === calls.length &&
                executed.every(({ result }) => result.status === "succeeded")
                    ? liveFixedOutcome(
                          executed.map(({ action }) => action),
                          liveAppStateView(options.context, options.appState),
                          options.context,
                      )
                    : undefined;
            if (fixed !== undefined) {
                conversation.messages.push({
                    role: "assistant",
                    content: [{ type: "text", text: fixed }],
                });
                return { text: fixed, outcome: "fixed" };
            }
            if (Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024) {
                phase = "context";
                throw fail("limit", "contextLimit");
            }
        }
        phase = "desktopAction";
        throw fail("limit", "actionLimit");
    } catch (error) {
        const failure =
            error instanceof LiveControllerError
                ? error
                : fail("inference", "providerRequestFailed");
        conversation.messages.push({
            role: "assistant",
            content: [{ type: "text", text: failure.voiceContext }],
        });
        throw failure;
    } finally {
        clearTimeout(timeout);
        abort.abort();
        if (unsettled !== undefined && session !== undefined) {
            // Never overlap two operations on a provider session. Late work owns only the retired instance.
            let timer!: ReturnType<typeof setTimeout>;
            const settled = await Promise.race([
                unsettled.then(
                    () => true,
                    () => true,
                ),
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), 3000);
                    timer.unref();
                }),
            ]);
            clearTimeout(timer);
            if (!settled && conversation.session === session) {
                conversation.session = undefined;
                void retireSession(conversation, session);
            }
        }
    }
}

async function untilAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    phase: LiveControllerDetail["phase"],
): Promise<T> {
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new LiveControllerError("deadline", { phase, reason: "deadline" }));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
    });
    try {
        return await Promise.race([promise, cancelled]);
    } finally {
        signal.removeEventListener("abort", cancel);
    }
}

/** Optional provider cleanup cannot replace the original outcome or hold voice open indefinitely. */
async function destroyBounded(session: BaseSession): Promise<void> {
    let timer!: ReturnType<typeof setTimeout>;
    try {
        await Promise.race([
            Promise.resolve()
                .then(() => session.destroy())
                .catch(() => undefined),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 3000);
                timer.unref();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
