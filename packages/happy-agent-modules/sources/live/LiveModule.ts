import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import {
    LIVE_DESKTOP_CAPABILITIES,
    createLiveSessionRequestSchema,
    liveControlClientMessageSchema,
    liveControlServerMessageSchema,
    voiceConfigPatchSchema,
    type CreateLiveSessionRequest,
    type LiveAppState,
    type LiveDesktopCapability,
    type LiveDesktopTarget,
    type VoiceConfig,
    type VoiceConfigPatch,
    type LiveSession,
    type LiveSessionUpdatedChanges,
    type LiveSessionCreatedPayload,
    type LiveSessionUpdatedPayload,
    type LiveControlClientMessage,
    type LiveControlServerMessage,
    type LiveDesktopAction,
    type LiveDesktopActionResult,
    type LiveDesktopContext,
    type LiveSessionRef,
} from "@slopus/happy-agent-client";
import type { SessionTool } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, asyncQueue, detach, shutdown, type Context } from "@steve.kite/stdlib";
import { BotsModule } from "../bots/index.js";
import {
    ConfigModule,
    VoiceCredentialPoolError,
    VoiceControllerRouteError,
    VoiceSettingsError,
    type VoiceSettingsUpdate,
} from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { liveVersion } from "./impl/liveVersion.js";
import { LiveError } from "./LiveError.js";
import {
    activeLiveSessions,
    liveMigrations,
    liveSessionExists,
    pruneLiveSessions,
    readLiveSession,
    saveLiveSession,
} from "./persistence/liveSessions.js";
import {
    LIVE_LATER_REQUEST_INSTRUCTIONS,
    LIVE_QUEUED_REQUEST_INSTRUCTIONS,
    LIVE_VOICE_INSTRUCTIONS,
} from "./impl/livePrompts.js";
import {
    runLiveController,
    liveControllerConversation,
    closeLiveController,
    LIVE_CONTROLLER_TOOLS,
    LIVE_MODEL_CHANGE_TOOLS,
    LIVE_TASK_CREATE_TOOLS,
} from "./impl/runLiveController.js";
import {
    liveAppStateAppends,
    liveAppStateEntities,
    liveAppStateView,
    liveTargetKey,
    renderLiveAppState,
    renderLiveAppStateUpdate,
    type LiveAppStatePushed,
} from "./impl/liveAppState.js";
import { liveMentionedTarget } from "./impl/liveMentionedTarget.js";
import { getVoiceSettingsTool } from "./tools/get_voice_settings.js";
import { setVoiceSettingsTool } from "./tools/set_voice_settings.js";
import { LiveControllerError } from "./impl/LiveControllerError.js";
import {
    liveActionSummary,
    liveContextSummary,
    logLiveDiagnostic,
    type LiveDiagnostic,
} from "./impl/liveDiagnostics.js";
import {
    createLiveProviderTransport,
    LiveProviderError,
    type LiveProviderEvent,
} from "./impl/liveProviderTransport.js";

const FRAME_BYTES = 256 * 1024;
const START = "live-start-once";
/** GPT-Live compacts older context, so a complete AppState is pushed again after this long. */
const APP_STATE_REFRESH_MS = 10 * 60 * 1000;
/** A failed background push is tried again after 1, 2, 4… seconds, at most this long apart. */
const APP_STATE_RETRY_MAX_MS = 60 * 1000;
type Transport = Awaited<ReturnType<typeof createLiveProviderTransport>>;
export interface LiveControlSocket {
    send(text: string): void;
    close(code: number, reason: string): void;
}
export interface LiveControlBinding {
    message(text: string): void;
    closed(): void;
}
export type LiveEvent =
    | { ownerId: string; type: "live.session.created"; payload: LiveSessionCreatedPayload }
    | { ownerId: string; type: "live.session.updated"; payload: LiveSessionUpdatedPayload };
interface ActionState {
    delegationId: string;
    action: LiveDesktopAction;
    result?: LiveDesktopActionResult;
    expired?: true;
    pendingLogged?: true;
    lateLogged?: true;
    startedAt: number;
    resolve: (result: LiveDesktopActionResult) => void;
    timer: ReturnType<typeof setTimeout>;
}
interface Call {
    ownerId: string;
    session: LiveSession;
    context: LiveDesktopContext;
    request: CreateLiveSessionRequest;
    route: Awaited<ReturnType<ConfigModule["liveControllerRoute"]>>;
    credential: Awaited<ReturnType<ConfigModule["liveCredential"]>>;
    abort: AbortController;
    controllerAbort: AbortController;
    allocated: ReturnType<typeof deferred<string>>;
    transport?: Transport;
    socket?: LiveControlSocket;
    claimed: boolean;
    controllerLost?: true;
    attachTimer?: ReturnType<typeof setTimeout>;
    queue: Promise<void>;
    controllerQueue: ReturnType<typeof asyncQueue>;
    controller: ReturnType<typeof liveControllerConversation>;
    /** Accepted desktop capabilities; empty for a desktop that negotiated none. */
    capabilities: LiveDesktopCapability[];
    /** The fixed controller arrays those capabilities select, merged once at creation. */
    tools: readonly SessionTool[];
    /** The voice model prompt captured when the call started. */
    voiceInstructions: string;
    appState?: LiveAppState;
    /** What the voice model was last told, for quiet diffs; the header time is never part of it. */
    pushed?: LiveAppStatePushed;
    fullPushedAt: number;
    refreshDue?: true;
    refreshTimer?: ReturnType<typeof setTimeout>;
    appStateTimer?: ReturnType<typeof setTimeout>;
    appStateSending?: true;
    /** Consecutive failed background pushes, for the retry backoff. */
    appStateFailures?: number;
    /** Accepted delegations without a delivered outcome; background pushes wait until none remain. */
    requests: number;
    heldNotices: Map<string, { text: string; speakable: boolean }>;
    /** The target voice is currently highlighting, and why. */
    focus?: { key: string; reason: "mention" | "navigation" };
    queued: number;
    queuedBytes: number;
    fragments: Extract<LiveControlServerMessage, { type: "transcript" }>[];
    actions: Map<string, ActionState>;
    watched: Set<string>;
    updates: Map<string, Extract<LiveControlClientMessage, { type: "sessionUpdate" }>>;
    delegations: Set<string>;
    frequentDiagnostics: number;
    suppressedDiagnostics: number;
    diagnosticTimes: Map<string, number>;
}

/** One window-scoped feature owns its persistence, provider call, control socket and side inference. */
export class LiveModule implements AgentModule {
    readonly name = "live";
    readonly migrations = liveMigrations;
    readonly #config: ConfigModule;
    readonly #durable: DurableFunctionsModule;
    readonly #bots: BotsModule;
    readonly #calls = new Map<string, Call>();
    readonly #listeners = new Set<(event: LiveEvent) => void>();
    readonly #settingsListeners = new Set<() => void>();
    #ctx: Context | undefined;
    #stopped = false;

    constructor(config: ConfigModule, durable: DurableFunctionsModule, bots: BotsModule) {
        this.#config = config;
        this.#durable = durable;
        this.#bots = bots;
        durable.register({
            name: START,
            argumentsSchema: Type.Object({ id: Type.String() }, { additionalProperties: false }),
            resultSchema: Type.Null(),
            executor: async (ctx, execution) => {
                const call = this.#calls.get(execution.arguments.id);
                // SDP and credential intent is process-private. A restarted invocation must never allocate.
                if (call === undefined) return null;
                const attempted = await execution.kv.read(ctx, "attempted");
                if (attempted !== undefined) {
                    await this.#fail(call, "Voice startup was interrupted and was not retried.");
                    return null;
                }
                await execution.kv.write(ctx, "attempted", true);
                await this.#start(call);
                return null;
            },
        });
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Voice requires the agent database.");
        this.#ctx = withAgentDatabase(detach(ctx).named("live-sessions"), database);
        shutdown.get(ctx)?.register("live", async () => await this.stop());
        await ctx.inTx(async (tx) => {
            for (const { ownerId, session } of await activeLiveSessions(tx)) {
                await this.#update(tx, ownerId, session, {
                    status: "failed",
                    error: "Voice ended because the daemon restarted. Start a new call explicitly.",
                    endedAt: Date.now(),
                    usage: { seconds: session.usage.seconds, final: false },
                });
            }
        });
        return {
            tools: async (toolCtx, scope) =>
                (await this.#isAdmin(toolCtx, scope.agent.id))
                    ? [
                          getVoiceSettingsTool(this, scope.agent.id),
                          setVoiceSettingsTool(this, scope.agent.id),
                      ]
                    : [],
        };
    };

    onEvent(listener: (event: LiveEvent) => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** The additive desktop capabilities this daemon accepts in a creation request. */
    get desktopCapabilities(): readonly LiveDesktopCapability[] {
        return LIVE_DESKTOP_CAPABILITIES;
    }

    /** Called after a stored voice setting changes. */
    onSettingsUpdated(listener: () => void): () => void {
        this.#settingsListeners.add(listener);
        return () => {
            this.#settingsListeners.delete(listener);
        };
    }

    /** The machine voice settings exactly as `config.voice` reports them. */
    voiceSettings(): VoiceConfig {
        const settings = this.#config.voiceSettings;
        const effective = this.#config.voiceController(settings);
        return {
            controller: {
                providerId: settings.controller_provider ?? null,
                modelId: settings.controller_model ?? null,
                effort: settings.controller_effort ?? null,
                fastMode: settings.controller_fast_mode ?? false,
            },
            effectiveController: {
                providerId: effective.providerId,
                modelId: effective.modelId,
                effort: effective.effort,
                serviceTier: effective.serviceTier,
                notice: effective.notice,
            },
            defaultSystemPrompt: LIVE_VOICE_INSTRUCTIONS,
            systemPromptOverride: settings.system_prompt ?? null,
            effectiveSystemPrompt: settings.system_prompt ?? LIVE_VOICE_INSTRUCTIONS,
        };
    }

    /**
     * HTTP authorization is owned by API. Omitted values are unchanged, `null` removes the stored
     * value, and the built-in prompt is never stored. Throws VoiceSettingsError for a refused change.
     */
    async updateVoiceSettings(ctx: Context, patch: VoiceConfigPatch): Promise<VoiceConfig> {
        if (!Value.Check(voiceConfigPatchSchema, patch))
            throw new VoiceSettingsError("The voice settings are invalid.");
        const controller = patch.controller;
        const prompt = patch.systemPrompt;
        const update: VoiceSettingsUpdate = {
            ...(controller?.providerId === undefined
                ? {}
                : { controller_provider: controller.providerId }),
            ...(controller?.modelId === undefined ? {} : { controller_model: controller.modelId }),
            ...(controller?.effort === undefined ? {} : { controller_effort: controller.effort }),
            ...(controller?.fastMode === undefined
                ? {}
                : { controller_fast_mode: controller.fastMode }),
            ...(prompt === undefined
                ? {}
                : { system_prompt: prompt === LIVE_VOICE_INSTRUCTIONS ? null : prompt }),
        };
        if (await this.#config.updateRuntimeVoiceSettings(ctx, update))
            for (const listener of this.#settingsListeners) listener();
        return this.voiceSettings();
    }

    async voiceSettingsForAdmin(ctx: Context, agentId: string): Promise<VoiceConfig> {
        await this.#requireAdmin(ctx, agentId);
        return this.voiceSettings();
    }

    async updateVoiceSettingsForAdmin(
        ctx: Context,
        agentId: string,
        patch: VoiceConfigPatch,
    ): Promise<VoiceConfig> {
        await this.#requireAdmin(ctx, agentId);
        return await this.updateVoiceSettings(ctx, patch);
    }

    /** Returns an allocation barrier, without waiting for external work in the caller's transaction. */
    async reserve(
        ctx: Context,
        ownerId: string,
        request: CreateLiveSessionRequest,
    ): Promise<{ session: LiveSession; allocated: Promise<string> }> {
        const capabilities = acceptedCapabilities(request.desktopCapabilities);
        if (
            !Value.Check(createLiveSessionRequestSchema, request) ||
            request.windowId !== request.context.windowId ||
            Buffer.byteLength(
                JSON.stringify({
                    type: "desktopContext",
                    revision: request.contextRevision,
                    context: request.context,
                }),
            ) > FRAME_BYTES ||
            (request.appState !== undefined &&
                (!capabilities.includes("appState") ||
                    Buffer.byteLength(JSON.stringify(request.appState)) > FRAME_BYTES)) ||
            (!capabilities.includes("appState") && namesTask(request.context))
        ) {
            throw new LiveError(
                400,
                "invalid_request",
                "The voice request or desktop context is invalid or too large.",
            );
        }
        if (this.#stopped) throw new LiveError(503, "live_unavailable", "Voice is shutting down.");
        let route: Call["route"];
        let credential: Call["credential"];
        try {
            route = await this.#config.liveControllerRoute();
        } catch (error) {
            throw new LiveError(
                503,
                "live_unavailable",
                error instanceof VoiceControllerRouteError
                    ? error.message
                    : "Voice cannot use the selected controller model. Check the voice settings and the selected account.",
            );
        }
        try {
            credential = await this.#config.liveCredential(request.credential);
        } catch (error) {
            throw new LiveError(
                503,
                "live_unavailable",
                error instanceof VoiceCredentialPoolError
                    ? error.message
                    : "Voice cannot use the selected OpenAI credential. Check that the selected account is enabled, signed in, and holds the selected credential type.",
            );
        }
        return await ctx.inTx(async (tx) => {
            const id = request.id ?? createId();
            const existing = await readLiveSession(tx, id, ownerId);
            if (existing !== undefined)
                throw new LiveError(
                    409,
                    "conflict",
                    "This voice session ID has already been used.",
                    existing,
                );
            if (await liveSessionExists(tx, id))
                throw new LiveError(404, "not_found", "The voice session was not found.");
            await pruneLiveSessions(tx, ownerId, Date.now());
            const active = await activeLiveSessions(tx, ownerId);
            if (
                active.length >= 4 ||
                active.some((item) => item.session.windowId === request.windowId)
            )
                throw new LiveError(
                    409,
                    "conflict",
                    "This window already has voice, or the account has four active voice sessions.",
                );
            const now = Date.now();
            const session: LiveSession = {
                id,
                windowId: request.windowId,
                credential: request.credential,
                contextRevision: request.contextRevision,
                status: "starting",
                usage: { seconds: null, final: false },
                error: null,
                createdAt: now,
                updatedAt: now,
                endedAt: null,
                version: liveVersion(),
            };
            await saveLiveSession(tx, ownerId, session);
            const voiceInstructions =
                this.#config.voiceSettings.system_prompt ?? LIVE_VOICE_INSTRUCTIONS;
            const call: Call = {
                ownerId,
                session,
                context: structuredClone(request.context),
                request: structuredClone(request),
                route,
                credential,
                abort: new AbortController(),
                controllerAbort: new AbortController(),
                allocated: deferred<string>(),
                claimed: false,
                queue: Promise.resolve(),
                controllerQueue: asyncQueue(),
                controller: liveControllerConversation(),
                capabilities,
                tools: [
                    ...LIVE_CONTROLLER_TOOLS,
                    ...(capabilities.includes("taskCreate") ? LIVE_TASK_CREATE_TOOLS : []),
                    ...(capabilities.includes("sessionModelChange") ? LIVE_MODEL_CHANGE_TOOLS : []),
                ],
                voiceInstructions,
                ...(request.appState === undefined
                    ? {}
                    : { appState: structuredClone(request.appState) }),
                fullPushedAt: 0,
                requests: 0,
                heldNotices: new Map(),
                queued: 0,
                queuedBytes: 0,
                fragments: [],
                actions: new Map(),
                watched: new Set(),
                updates: new Map(),
                delegations: new Set(),
                frequentDiagnostics: 0,
                suppressedDiagnostics: 0,
                diagnosticTimes: new Map(),
            };
            // Observe rejection even when an outer transaction rolls back or the HTTP caller leaves.
            void call.allocated.promise.catch(() => undefined);
            afterCommit(tx, () => {
                this.#calls.set(id, call);
                this.#diagnostic(call, {
                    event: "session.created",
                    controllerProviderId: route.model.providerId,
                    model: route.model.id,
                    effort: route.effort,
                    ...(route.serviceTier === undefined ? {} : { serviceTier: route.serviceTier }),
                    capabilities,
                    credentialKind: session.credential.type,
                    credentialProviderId: session.credential.providerId,
                    context: liveContextSummary(call.context),
                });
                this.#emit({
                    ownerId,
                    type: "live.session.created",
                    payload: {
                        session,
                        ...(request.mutationId === undefined
                            ? {}
                            : { mutationId: request.mutationId }),
                    },
                });
            });
            await this.#durable.invoke(tx, {
                function: START,
                arguments: { id },
                operationId: `live:${id}`,
            });
            return { session, allocated: call.allocated.promise };
        });
    }

    async get(ctx: Context, ownerId: string, id: string): Promise<LiveSession> {
        return await ctx.inTx(async (tx) => {
            await pruneLiveSessions(tx, ownerId, Date.now());
            const session = await readLiveSession(tx, id, ownerId);
            if (session === undefined)
                throw new LiveError(404, "not_found", "The voice session was not found.");
            return session;
        });
    }

    async close(
        ctx: Context,
        ownerId: string,
        id: string,
        mutationId?: string,
    ): Promise<LiveSession> {
        return await ctx.inTx(async (tx) => {
            const session = await this.get(tx, ownerId, id);
            if (terminal(session) || session.status === "closing") return session;
            const next = await this.#update(
                tx,
                ownerId,
                session,
                { status: "closing", error: null },
                mutationId,
            );
            afterCommit(tx, () => {
                const call = this.#calls.get(id);
                if (call === undefined) return;
                call.controllerAbort.abort();
                this.#cancelActions(call);
                if (call.transport === undefined)
                    void this.#fail(call, "Voice was stopped before startup completed.");
                else
                    void call.transport
                        .close()
                        .catch(() =>
                            this.#fail(call, "The voice connection could not close cleanly."),
                        );
            });
            return next;
        });
    }

    async prepareControl(
        ctx: Context,
        ownerId: string,
        id: string,
        windowId: string,
    ): Promise<{ attach(socket: LiveControlSocket): LiveControlBinding; failed(): void }> {
        const session = await this.get(ctx, ownerId, id);
        const call = this.#calls.get(id);
        if (
            session.windowId !== windowId ||
            terminal(session) ||
            call === undefined ||
            call.claimed
        )
            throw new LiveError(
                409,
                "conflict",
                "This voice session cannot attach to that window or already has a controller.",
            );
        call.claimed = true;
        return {
            failed: () => {
                void this.#fail(
                    call,
                    "The desktop controller connection could not be established.",
                );
            },
            attach: (socket) => {
                if (terminal(call.session)) {
                    socket.close(1008, "Voice has ended.");
                    return { message() {}, closed() {} };
                }
                call.socket = socket;
                this.#diagnostic(call, { event: "control.attached" });
                clearTimeout(call.attachTimer);
                this.#send(call, {
                    type: "hello",
                    sessionId: id,
                    windowId,
                    contextRevision: call.session.contextRevision,
                    ...(call.request.desktopCapabilities === undefined
                        ? {}
                        : { capabilities: call.capabilities }),
                });
                this.#send(call, {
                    type: "status",
                    status: call.session.status,
                    error: call.session.error,
                });
                for (const fragment of call.fragments) this.#send(call, fragment);
                return {
                    message: (text) =>
                        this.#enqueue(call, text.length * 3, async () => {
                            if (Buffer.byteLength(text) > FRAME_BYTES)
                                throw new Error(
                                    "The desktop control message exceeded its size limit.",
                                );
                            const message: unknown = JSON.parse(text);
                            if (!Value.Check(liveControlClientMessageSchema, message))
                                throw new Error("The desktop control message was invalid.");
                            await this.#message(call, message);
                        }),
                    closed: () => {
                        if (!terminal(call.session) && call.session.status !== "closing") {
                            this.#diagnostic(call, {
                                event: "control.lost",
                                reason: "connectionLost",
                            });
                            call.controllerLost = true;
                            delete call.socket;
                            void this.close(this.#context(), ownerId, id).catch(() =>
                                this.#fail(call, "The desktop controller disconnected."),
                            );
                        }
                    },
                };
            },
        };
    }

    async stop(): Promise<void> {
        this.#stopped = true;
        await Promise.all(
            [...this.#calls.values()].map(async (call) => {
                await this.close(this.#context(), call.ownerId, call.session.id);
                await call.transport?.close();
                await call.queue;
            }),
        );
    }

    async #start(call: Call): Promise<void> {
        try {
            const now = Date.now();
            const snapshot = renderLiveAppState(this.#view(call), now);
            call.transport = await createLiveProviderTransport({
                credential: call.credential,
                sdp: call.request.sdp,
                instructions: call.voiceInstructions,
                initialContext: `# ${snapshot.title}\n\n${snapshot.body}`,
                signal: call.abort.signal,
                onEvent: (event) =>
                    this.#enqueue(call, Buffer.byteLength(JSON.stringify(event)), () =>
                        this.#providerEvent(call, event),
                    ),
            });
            call.request.sdp = "";
            delete call.request.appState;
            call.pushed = snapshot.pushed;
            call.fullPushedAt = now;
            this.#scheduleRefresh(call);
            this.#diagnostic(call, {
                event: "appState.pushed",
                snapshotKind: "full",
                appendCount: 1,
                bytes: Buffer.byteLength(snapshot.body),
            });
            if (terminal(call.session) || call.session.status === "closing") {
                call.transport.dispose();
                throw new Error("Voice stopped during startup.");
            }
            if (call.socket === undefined) {
                call.attachTimer = setTimeout(() => {
                    void this.#fail(call, "The desktop did not attach to voice within 15 seconds.");
                }, 15_000);
                call.attachTimer.unref();
            }
            call.allocated.resolve(call.transport.sdp);
        } catch (error) {
            await this.#fail(
                call,
                error instanceof LiveProviderError
                    ? error.message
                    : "Voice could not start on the selected account. Check GPT-Live access and connectivity; no fallback or retry was attempted.",
                error instanceof LiveProviderError ? error : undefined,
            );
        }
    }

    async #providerEvent(call: Call, event: LiveProviderEvent): Promise<void> {
        if (terminal(call.session)) return;
        if (event.type === "ready") {
            this.#diagnostic(call, { event: "provider.ready" });
            if (call.session.status === "starting") {
                await this.#change(call, { status: "active" });
                // AppState that changed during startup reaches voice once it can be told.
                if (
                    call.pushed !== undefined &&
                    renderLiveAppStateUpdate(call.pushed, this.#view(call), Date.now()) !==
                        undefined
                )
                    this.#queueAppState(call);
            }
        } else if (event.type === "usage") {
            await this.#change(call, {
                usage: event.final
                    ? { seconds: event.seconds, final: true }
                    : { seconds: event.seconds, final: false },
            });
        } else if (event.type === "ended") {
            await this.#change(call, {
                status: event.orderly && !call.controllerLost ? "closed" : "failed",
                error: call.controllerLost
                    ? "The desktop controller disconnected."
                    : event.orderly
                      ? null
                      : (event.error ?? "The voice connection ended unexpectedly."),
                endedAt: Date.now(),
            });
            call.allocated.reject(
                new LiveError(
                    event.code === "forbidden" ? 403 : event.code === "unsupported" ? 501 : 503,
                    event.code ?? "live_unavailable",
                    event.error ?? "Voice ended before startup completed.",
                    call.session,
                ),
            );
            this.#dispose(call);
        } else if (event.type === "transcript") {
            const fragment: Extract<LiveControlServerMessage, { type: "transcript" }> = {
                type: "transcript",
                transcriptId: createId(),
                role: event.role,
                text: event.text,
                ...("startMs" in event && event.startMs !== undefined
                    ? { startMs: event.startMs, endMs: event.endMs! }
                    : {}),
            };
            if (!Value.Check(liveControlServerMessageSchema, fragment))
                throw new Error("The voice transcript exceeded its protocol limits.");
            call.fragments.push(fragment);
            this.#diagnostic(call, {
                event: "transcript.received",
                transcriptId: fragment.transcriptId,
                role: fragment.role,
                characters: fragment.text.length,
            });
            while (
                call.fragments.length > 32 ||
                Buffer.byteLength(JSON.stringify(call.fragments)) > 65536
            )
                call.fragments.shift();
            this.#send(call, fragment);
        } else if (event.type === "delegation") {
            if (call.session.status !== "active" || call.socket === undefined)
                throw new Error("Voice requested an action before the desktop was ready.");
            if (call.delegations.has(event.delegationId)) return;
            if (call.delegations.size >= 256)
                throw new Error("Voice exceeded its bounded delegation capacity.");
            call.delegations.add(event.delegationId);
            // Background AppState waits until this request's outcome is delivered.
            call.requests += 1;
            const fragments = [...call.fragments];
            const queuedAt = Date.now();
            this.#diagnostic(call, {
                event: "delegation.queued",
                delegationId: event.delegationId,
                characters: event.text?.length ?? 0,
                fragmentCount: fragments.length,
                inputTranscriptIds: fragments.map((fragment) => fragment.transcriptId),
                inFlight: call.requests,
            });
            let startedAt = queuedAt;
            const run = async (ctx: Context): Promise<string | undefined> => {
                if (call.session.status !== "active" || call.controllerAbort.signal.aborted)
                    return undefined;
                if (Date.now() - queuedAt >= 120_000)
                    return "This desktop request expired while waiting in the queue. No action was started for it.";
                startedAt = Date.now();
                const mentioned = liveMentionedTarget(
                    this.#view(call),
                    event.text ??
                        fragments
                            .filter((fragment) => fragment.role === "user")
                            .slice(-4)
                            .map((fragment) => fragment.text)
                            .join("\n"),
                );
                if (mentioned !== undefined) this.#focus(call, mentioned, "mention");
                this.#diagnostic(call, {
                    event: "delegation.started",
                    delegationId: event.delegationId,
                    characters: event.text?.length ?? 0,
                    fragmentCount: fragments.length,
                    snapshotCount: call.updates.size,
                    inputTranscriptIds: fragments.map((fragment) => fragment.transcriptId),
                    context: liveContextSummary(call.context),
                });
                return await runLiveController(ctx, {
                    provider: call.route.provider,
                    conversation: call.controller,
                    model: call.route.model.id,
                    effort: call.route.effort,
                    ...(call.route.serviceTier === undefined
                        ? {}
                        : { serviceTier: call.route.serviceTier }),
                    tools: call.tools,
                    signal: AbortSignal.any([call.controllerAbort.signal, call.route.signal]),
                    context: structuredClone(call.context),
                    ...(call.appState === undefined
                        ? {}
                        : { appState: structuredClone(call.appState) }),
                    fragments,
                    sessionUpdates: [...call.updates.values()],
                    ...(event.text === undefined ? {} : { delegationText: event.text }),
                    execute: (action) =>
                        this.#execute(
                            call,
                            event.delegationId,
                            action,
                            fragments.map((fragment) => fragment.transcriptId),
                        ),
                })
                    .then(({ text, outcome }) => {
                        this.#diagnostic(call, {
                            event: "controller.finished",
                            delegationId: event.delegationId,
                            durationMs: Date.now() - startedAt,
                            characters: text.length,
                            outcome,
                        });
                        return text;
                    })
                    .catch(async (error: unknown) => {
                        if (call.session.status !== "active") return undefined;
                        if (call.route.signal.aborted) {
                            await this.#fail(
                                call,
                                "The configured desktop controller account is no longer available.",
                            );
                            return undefined;
                        }
                        const failure =
                            error instanceof LiveControllerError
                                ? error
                                : new LiveControllerError("inference");
                        const actionCount = [...call.actions.values()].filter(
                            (pending) => pending.delegationId === event.delegationId,
                        ).length;
                        this.#diagnostic(call, {
                            event: "controller.failed",
                            delegationId: event.delegationId,
                            durationMs: Date.now() - startedAt,
                            category: failure.category,
                            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
                            actionCount,
                        });
                        for (const pending of call.actions.values()) {
                            if (
                                pending.delegationId === event.delegationId &&
                                pending.result === undefined
                            ) {
                                pending.expired = true;
                                clearTimeout(pending.timer);
                                pending.resolve({
                                    status: "failed",
                                    code: "failed",
                                    message:
                                        "The controller request ended before the action's outcome was confirmed.",
                                });
                            }
                        }
                        if (failure.category === "capacity") {
                            await this.#fail(call, failure.message);
                            return undefined;
                        }
                        return failure.voiceContext;
                    });
            };
            // Delivery and this request's focus cleanup stay inside its FIFO turn, so a queued
            // request never highlights or acts while the previous outcome is still being appended.
            void call.controllerQueue
                .runInLock(detach(this.#context()).named("live-desktop-delegation"), (ctx) =>
                    run(ctx)
                        .then(async (text) => {
                            if (
                                text !== undefined &&
                                !terminal(call.session) &&
                                call.session.status === "active"
                            ) {
                                if (call.transport === undefined)
                                    throw new Error("The voice transport is unavailable.");
                                const inFlight = call.requests;
                                const outcomeHint = inFlight > 1 ? "queued" : "later";
                                const instructions =
                                    outcomeHint === "queued"
                                        ? LIVE_QUEUED_REQUEST_INSTRUCTIONS
                                        : LIVE_LATER_REQUEST_INSTRUCTIONS;
                                await call.transport.append({
                                    delegationId: event.delegationId,
                                    text: `${text || "The desktop request has completed."}\n\n${instructions}`,
                                    speakable: true,
                                });
                                this.#diagnostic(call, {
                                    event: "delegation.delivered",
                                    delegationId: event.delegationId,
                                    inFlight,
                                    outcomeHint,
                                    durationMs: Date.now() - startedAt,
                                });
                            }
                        })
                        .catch(async () => {
                            this.#diagnostic(call, {
                                event: "delivery.failed",
                                delegationId: event.delegationId,
                                reason: "responseDelivery",
                                durationMs: Date.now() - startedAt,
                            });
                            if (call.session.status === "active")
                                await this.#fail(
                                    call,
                                    "Voice could not deliver the desktop controller's response. Its outcome was not retried.",
                                );
                        })
                        .finally(() => this.#clearFocus(call)),
                )
                .finally(() => {
                    call.requests -= 1;
                    if (call.requests === 0) this.#releaseHeld(call);
                });
        }
    }

    async #message(call: Call, message: LiveControlClientMessage): Promise<void> {
        if (terminal(call.session)) return;
        if (message.type === "desktopContext") {
            if (message.context.windowId !== call.session.windowId)
                throw new Error("The desktop context belongs to a different window.");
            if (message.revision < call.session.contextRevision) return;
            if (message.revision === call.session.contextRevision) {
                if (!Value.Equal(message.context, call.context))
                    throw new Error("Conflicting desktop contexts used the same revision.");
                return;
            }
            if (!call.capabilities.includes("appState") && namesTask(message.context))
                throw new Error("The desktop named a task without negotiating AppState.");
            call.context = message.context;
            const activeKey =
                message.context.activeSession === null
                    ? undefined
                    : sessionKey(message.context.activeSession.target);
            for (const key of call.updates.keys())
                if (key !== activeKey && !call.watched.has(key)) call.updates.delete(key);
            await this.#change(call, { contextRevision: message.revision });
            this.#diagnostic(call, {
                event: "context.accepted",
                context: liveContextSummary(call.context),
            });
            this.#queueAppState(call);
        } else if (message.type === "actionResult") {
            const pending = call.actions.get(message.actionId);
            if (pending === undefined) throw new Error("The desktop answered an unknown action.");
            if (pending.expired) {
                if (!pending.lateLogged) {
                    pending.lateLogged = true;
                    this.#diagnostic(call, {
                        event: "action.lateIgnored",
                        delegationId: pending.delegationId,
                        actionId: message.actionId,
                        actionType: pending.action.type,
                    });
                }
                return;
            }
            if (pending.result !== undefined) {
                if (!Value.Equal(pending.result, message.result))
                    throw new Error("The desktop changed a completed action result.");
                return;
            }
            if (message.result.status === "pending") {
                if (!pending.pendingLogged) {
                    pending.pendingLogged = true;
                    this.#diagnostic(call, {
                        event: "action.result",
                        delegationId: pending.delegationId,
                        actionId: message.actionId,
                        actionType: pending.action.type,
                        resultStatus: "pending",
                        durationMs: Date.now() - pending.startedAt,
                    });
                }
                if (pending.action.type === "sessionSend")
                    throw new Error(
                        "Message staging cannot wait for human confirmation as a pending action.",
                    );
                return;
            }
            if (message.result.status === "succeeded") {
                if (
                    (message.result.output.type === "staged") !==
                    (pending.action.type === "sessionSend")
                )
                    throw new Error("The desktop returned an invalid staging result.");
                if (pending.action.type === "sessionWatch") {
                    const key = sessionKey(pending.action.target);
                    if (pending.action.enabled) call.watched.add(key);
                    else {
                        call.watched.delete(key);
                        if (
                            call.context.activeSession === null ||
                            sessionKey(call.context.activeSession.target) !== key
                        )
                            call.updates.delete(key);
                    }
                }
            }
            clearTimeout(pending.timer);
            pending.result = message.result;
            this.#diagnostic(call, {
                event: "action.result",
                delegationId: pending.delegationId,
                actionId: message.actionId,
                actionType: pending.action.type,
                resultStatus: message.result.status,
                durationMs: Date.now() - pending.startedAt,
                ...(message.result.status === "succeeded"
                    ? {
                          outputType: message.result.output.type,
                          ...(message.result.output.type === "context"
                              ? { context: liveContextSummary(message.result.output.context) }
                              : {}),
                      }
                    : { resultCode: message.result.code }),
            });
            pending.resolve(message.result);
        } else if (message.type === "appState") {
            if (!call.capabilities.includes("appState"))
                throw new Error("The desktop sent AppState without negotiating it.");
            if (call.appState !== undefined && Value.Equal(call.appState, message.appState)) return;
            call.appState = message.appState;
            this.#diagnostic(call, {
                event: "appState.accepted",
                bytes: Buffer.byteLength(JSON.stringify(message.appState)),
            });
            this.#queueAppState(call);
        } else {
            const key = sessionKey(message.target);
            if (
                key !==
                    (call.context.activeSession === null
                        ? undefined
                        : sessionKey(call.context.activeSession.target)) &&
                !call.watched.has(key)
            )
                throw new Error("The desktop updated an unselected conversation.");
            if (
                !call.context.sessions.some((item) => sessionKey(item.target) === key) &&
                !call.context.bots.some((item) => sessionKey(item.target) === key) &&
                (call.context.activeSession === null ||
                    sessionKey(call.context.activeSession.target) !== key)
            )
                throw new Error("The desktop updated an inaccessible conversation.");
            const previous = call.updates.get(key);
            if (previous !== undefined && Value.Equal(previous, message)) return;
            // Without AppState, the focused conversation's latest message comes from its snapshot.
            if (!call.capabilities.includes("appState")) this.#queueAppState(call);
            const priorStatus =
                previous?.status ??
                (call.context.activeSession !== null &&
                sessionKey(call.context.activeSession.target) === key
                    ? call.context.activeSession.status
                    : undefined);
            call.updates.set(key, message);
            this.#diagnostic(call, {
                event: "session.snapshot",
                target: message.target,
                characters: message.messages.reduce((sum, item) => sum + item.text.length, 0),
                snapshotCount: call.updates.size,
            });
            if (
                call.updates.size > 6 ||
                Buffer.byteLength(JSON.stringify([...call.updates.values()])) > 128 * 1024
            )
                throw new Error("Voice exceeded its selected conversation context limit.");
            const speakable =
                message.status !== priorStatus &&
                (message.status === "error" ||
                    message.status === "awaitingInput" ||
                    (message.status === "idle" &&
                        (priorStatus === "running" || priorStatus === "waiting")));
            if (message.status === priorStatus) return;
            const title =
                call.context.sessions.find((item) => sessionKey(item.target) === key)?.title ??
                call.context.bots.find((item) => sessionKey(item.target) === key)?.name;
            const lastAssistant = message.messages.findLast((item) => item.role === "assistant");
            const notice = {
                text: JSON.stringify({
                    title: title?.slice(0, 256) ?? "Selected conversation",
                    status: message.status,
                    lastAssistantMessage: lastAssistant?.text.slice(0, 1600) ?? null,
                }),
                speakable,
            };
            // Like AppState, a status notice never reaches voice while a request awaits its outcome.
            if (call.requests > 0) {
                call.heldNotices.delete(key);
                call.heldNotices.set(key, notice);
                return;
            }
            await call.transport?.append({ delegationId: null, ...notice }).catch(() => undefined);
        }
    }

    /**
     * The desktop stages and appends only in the focused conversation, and models opened it
     * without then staging. A send or draft names its conversation, so one that is not focused is
     * opened first; a refused open is that action's result and nothing is staged.
     */
    async #execute(
        call: Call,
        delegationId: string,
        action: LiveDesktopAction,
        inputTranscriptIds: string[],
    ): Promise<LiveDesktopActionResult> {
        if (
            (action.type === "sessionSend" || action.type === "composerDraftAppend") &&
            (call.context.activeSession === null ||
                liveTargetKey(call.context.activeSession.target) !== liveTargetKey(action.target))
        ) {
            const opened = await this.#action(
                call,
                delegationId,
                { type: "desktopOpen", target: this.#conversationTarget(call, action.target) },
                inputTranscriptIds,
            );
            if (opened.status !== "succeeded") return opened;
        }
        return await this.#action(call, delegationId, action, inputTranscriptIds);
    }

    async #action(
        call: Call,
        delegationId: string,
        action: LiveDesktopAction,
        inputTranscriptIds: string[],
    ): Promise<LiveDesktopActionResult> {
        if (terminal(call.session) || call.session.status !== "active" || call.socket === undefined)
            throw new Error("Voice cannot start another desktop action.");
        if (call.actions.size >= 256) throw new LiveControllerError("capacity");
        if (
            [...call.actions.values()].some(
                (pending) => pending.result === undefined && !pending.expired,
            )
        )
            throw new LiveControllerError("invalidAction");
        if (
            (action.type === "taskCreate" && !call.capabilities.includes("taskCreate")) ||
            (action.type === "sessionModelChange" &&
                !call.capabilities.includes("sessionModelChange")) ||
            (action.type === "desktopOpen" &&
                action.target.kind === "task" &&
                !call.capabilities.includes("appState"))
        )
            throw new LiveControllerError("invalidAction");
        if (action.type === "sessionWatch" && action.enabled) {
            const targets = new Set(call.watched);
            for (const pending of call.actions.values())
                if (
                    !pending.expired &&
                    pending.result === undefined &&
                    pending.action.type === "sessionWatch" &&
                    pending.action.enabled
                )
                    targets.add(sessionKey(pending.action.target));
            if (!targets.has(sessionKey(action.target)) && targets.size >= 5)
                return {
                    status: "refused",
                    code: "unavailable",
                    message: "At most five conversations can be watched.",
                };
        }
        const actionId = createId();
        const startedAt = Date.now();
        const result = deferred<LiveDesktopActionResult>();
        const timer = setTimeout(() => {
            const pending = call.actions.get(actionId);
            if (pending !== undefined) pending.expired = true;
            this.#diagnostic(call, {
                event: "action.expired",
                delegationId,
                actionId,
                actionType: action.type,
                durationMs: Date.now() - startedAt,
                reason: "actionTimeout",
            });
            result.reject(
                new LiveControllerError("uncertainAction", {
                    phase: "desktopAction",
                    reason: "actionUncertain",
                }),
            );
        }, 60_000);
        timer.unref();
        call.actions.set(actionId, {
            delegationId,
            action,
            resolve: result.resolve,
            timer,
            startedAt,
        });
        this.#diagnostic(call, {
            event: "action.requested",
            delegationId,
            actionId,
            ...liveActionSummary(action),
            context: liveContextSummary(call.context),
        });
        const target = this.#actionTarget(call, action);
        if (target !== undefined)
            this.#focus(call, target, action.type === "desktopOpen" ? "navigation" : "mention");
        this.#send(call, {
            type: "actionRequested",
            actionId,
            contextRevision: call.session.contextRevision,
            inputTranscriptIds,
            action,
        });
        return await result.promise;
    }

    #enqueue(call: Call, bytes: number, work: () => Promise<void>): void {
        if (terminal(call.session)) return;
        if (++call.queued > 64 || (call.queuedBytes += bytes) > 1024 * 1024) {
            void this.#fail(call, "Voice exceeded its control queue limit.");
            return;
        }
        call.queue = call.queue
            .then(work)
            .catch(() => {
                this.#diagnostic(call, { event: "control.invalid", reason: "invalidControlData" });
                return this.#fail(
                    call,
                    "Voice received invalid or conflicting control data and ended safely.",
                );
            })
            .finally(() => {
                call.queued -= 1;
                call.queuedBytes -= bytes;
            });
    }

    #send(call: Call, message: LiveControlServerMessage): void {
        if (call.socket === undefined) return;
        if (!Value.Check(liveControlServerMessageSchema, message))
            throw new Error("The voice control response is invalid.");
        const text = JSON.stringify(message);
        if (Buffer.byteLength(text) > FRAME_BYTES)
            throw new Error("The voice control response is too large.");
        try {
            call.socket.send(text);
        } catch {
            delete call.socket;
            void this.#fail(call, "The desktop control connection could not keep up.");
        }
    }

    async #change(
        call: Call,
        changes: Omit<LiveSessionUpdatedChanges, "updatedAt">,
    ): Promise<void> {
        await this.#context().inTx(async (tx) => {
            const current = await readLiveSession(tx, call.session.id, call.ownerId);
            if (current === undefined || terminal(current)) return;
            await this.#update(tx, call.ownerId, current, changes);
        });
    }

    async #update(
        ctx: Context,
        ownerId: string,
        current: LiveSession,
        changes: Omit<LiveSessionUpdatedChanges, "updatedAt">,
        mutationId?: string,
    ): Promise<LiveSession> {
        const update = { ...changes, updatedAt: Date.now() };
        const session = { ...current, ...update, version: liveVersion(current.version) };
        await saveLiveSession(ctx, ownerId, session);
        afterCommit(ctx, () => {
            const call = this.#calls.get(session.id);
            if (call !== undefined) {
                call.session = session;
                if (changes.status !== undefined)
                    this.#diagnostic(call, { event: "session.status", status: session.status });
                this.#send(call, { type: "status", status: session.status, error: session.error });
            }
            this.#emit({
                ownerId,
                type: "live.session.updated",
                payload: {
                    sessionId: session.id,
                    previousVersion: current.version,
                    version: session.version,
                    changes: update,
                    ...(mutationId === undefined ? {} : { mutationId }),
                },
            });
        });
        return session;
    }

    async #fail(call: Call, error: string, providerError?: LiveProviderError): Promise<void> {
        if (!terminal(call.session))
            await this.#change(call, { status: "failed", error, endedAt: Date.now() });
        call.allocated.reject(
            new LiveError(
                providerError?.status ?? 503,
                providerError?.code ?? "live_unavailable",
                error,
                call.session,
            ),
        );
        this.#dispose(call);
    }
    #cancelActions(call: Call): void {
        for (const pending of call.actions.values()) {
            clearTimeout(pending.timer);
            if (pending.result === undefined)
                pending.resolve({
                    status: "cancelled",
                    code: "ended",
                    message: "Voice has ended; already-started actions may still complete.",
                });
        }
    }
    #dispose(call: Call): void {
        clearTimeout(call.attachTimer);
        clearTimeout(call.appStateTimer);
        clearTimeout(call.refreshTimer);
        this.#cancelActions(call);
        call.abort.abort();
        call.controllerAbort.abort();
        closeLiveController(call.controller);
        call.transport?.dispose();
        call.socket?.close(1000, "Voice has ended.");
        this.#calls.delete(call.session.id);
    }
    /** The AppState voice is told about: the desktop's own, or one derived from its context. */
    #view(call: Call) {
        return liveAppStateView(call.context, call.appState, [...call.updates.values()]);
    }

    /** Coalesce for 250 ms with one push in flight; a running request holds pushes until it ends. */
    #queueAppState(call: Call, delayMs = 250): void {
        if (
            call.appStateTimer !== undefined ||
            call.appStateSending ||
            call.requests > 0 ||
            call.session.status !== "active"
        )
            return;
        call.appStateTimer = setTimeout(() => {
            delete call.appStateTimer;
            void this.#pushAppState(call);
        }, delayMs);
        call.appStateTimer.unref();
    }

    /**
     * Voice counts as told only after every part is appended. A request that starts between parts
     * holds the rest, and a failed append is pushed again after a bounded backoff; either way the
     * next push is computed afresh against what voice was last fully told.
     */
    async #pushAppState(call: Call): Promise<void> {
        const transport = call.transport;
        if (call.session.status !== "active" || transport === undefined || call.requests > 0)
            return;
        const now = Date.now();
        const view = this.#view(call);
        const full =
            call.pushed === undefined ||
            call.refreshDue === true ||
            now - call.fullPushedAt >= APP_STATE_REFRESH_MS;
        // Only the startup snapshot is bounded; a later complete snapshot is split, never truncated.
        const rendered = full
            ? renderLiveAppState(view, now, Number.POSITIVE_INFINITY)
            : renderLiveAppStateUpdate(call.pushed!, view, now);
        if (rendered === undefined) return;
        const appends = liveAppStateAppends(rendered.title, rendered.body);
        call.appStateSending = true;
        let retryMs: number | undefined;
        let delivered = 0;
        try {
            for (const text of appends) {
                if (call.requests > 0 || call.session.status !== "active") {
                    if (delivered > 0) call.refreshDue = true;
                    return;
                }
                await transport.append({ delegationId: null, text, speakable: false });
                delivered += 1;
            }
            call.pushed = rendered.pushed;
            delete call.appStateFailures;
            if (full) {
                delete call.refreshDue;
                call.fullPushedAt = now;
                this.#scheduleRefresh(call);
            }
            this.#diagnostic(call, {
                event: "appState.pushed",
                snapshotKind: full ? "full" : "update",
                appendCount: appends.length,
                bytes: appends.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
            });
        } catch {
            // AppState is background context; a failed append never fails the call.
            // A partial delivery may have changed facts that later reverted to the old baseline.
            if (delivered > 0) call.refreshDue = true;
            call.appStateFailures = (call.appStateFailures ?? 0) + 1;
            retryMs = Math.min(APP_STATE_RETRY_MAX_MS, 1000 * 2 ** (call.appStateFailures - 1));
        } finally {
            delete call.appStateSending;
            this.#queueAppState(call, retryMs);
        }
    }

    #scheduleRefresh(call: Call): void {
        clearTimeout(call.refreshTimer);
        call.refreshTimer = setTimeout(() => {
            call.refreshDue = true;
            this.#queueAppState(call);
        }, APP_STATE_REFRESH_MS);
        call.refreshTimer.unref();
    }

    /** Deliver what waited for a request's outcome: status notices first, then AppState. */
    #releaseHeld(call: Call): void {
        const notices = [...call.heldNotices.values()];
        call.heldNotices.clear();
        if (call.session.status === "active")
            for (const notice of notices)
                void call.transport
                    ?.append({ delegationId: null, ...notice })
                    .catch(() => undefined);
        this.#queueAppState(call);
    }

    /**
     * Highlight what voice is talking about. Decorative, and never sent without the capability.
     * The same target is repeated only to announce that it is about to be opened.
     */
    #focus(call: Call, target: LiveDesktopTarget, reason: "mention" | "navigation"): void {
        const key = liveTargetKey(target);
        if (
            !call.capabilities.includes("voiceFocus") ||
            (call.focus?.key === key && (reason === "mention" || call.focus.reason === reason))
        )
            return;
        call.focus = { key, reason };
        this.#send(call, {
            type: "voiceFocus",
            focusId: createId(),
            contextRevision: call.session.contextRevision,
            target,
            reason,
        });
        this.#diagnostic(call, { event: "focus.sent", focusReason: reason });
    }

    #clearFocus(call: Call): void {
        if (call.focus === undefined) return;
        delete call.focus;
        if (terminal(call.session)) return;
        this.#send(call, {
            type: "voiceFocus",
            focusId: createId(),
            contextRevision: call.session.contextRevision,
            target: null,
            reason: "mention",
        });
        this.#diagnostic(call, { event: "focus.sent", focusReason: "clear" });
    }

    /** The desktop target an action is about, named as the sidebar names it. */
    #actionTarget(call: Call, action: LiveDesktopAction): LiveDesktopTarget | undefined {
        if (action.type === "desktopOpen") return action.target;
        return "target" in action ? this.#conversationTarget(call, action.target) : undefined;
    }

    /** A conversation as the sidebar shows it: a bot, a task, or an ordinary session. */
    #conversationTarget(call: Call, ref: LiveSessionRef): LiveDesktopTarget {
        const key = liveTargetKey(ref);
        return (
            liveAppStateEntities(this.#view(call)).find((entity) => entity.key === key)?.target ??
            call.context.bots.find((bot) => liveTargetKey(bot.target) === key)?.target ?? {
                kind: "session",
                ...ref,
            }
        );
    }

    async #requireAdmin(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.#isAdmin(ctx, agentId)))
            throw new Error("Only an active admin bot can read or change voice settings.");
    }

    async #isAdmin(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    #emit(event: LiveEvent): void {
        for (const listener of this.#listeners) listener(event);
    }
    #diagnostic(call: Call, diagnostic: LiveDiagnostic): void {
        try {
            const now = Date.now();
            // Only these three streaming event kinds may grow independently of the call's action bounds.
            if (
                diagnostic.event === "context.accepted" ||
                diagnostic.event === "transcript.received" ||
                diagnostic.event === "session.snapshot"
            ) {
                if (
                    call.frequentDiagnostics >= 1024 ||
                    now - (call.diagnosticTimes.get(diagnostic.event) ?? 0) < 100
                ) {
                    call.suppressedDiagnostics++;
                    return;
                }
                call.frequentDiagnostics++;
                call.diagnosticTimes.set(diagnostic.event, now);
            }
            logLiveDiagnostic(
                this.#context(),
                {
                    sessionId: call.session.id,
                    windowId: call.session.windowId,
                    contextRevision: call.session.contextRevision,
                    elapsedMs: now - call.session.createdAt,
                    suppressed: call.suppressedDiagnostics,
                },
                diagnostic,
            );
        } catch {
            // Diagnostics are optional and may not interfere with the media or controller.
        }
    }
    #context(): Context {
        if (this.#ctx === undefined) throw new Error("Voice has not started.");
        return this.#ctx;
    }
}

/** The daemon's capabilities the desktop asked for; task and model actions need AppState. */
function acceptedCapabilities(requested: unknown): LiveDesktopCapability[] {
    if (!Array.isArray(requested)) return [];
    const accepted = LIVE_DESKTOP_CAPABILITIES.filter((name) => requested.includes(name));
    return accepted.filter(
        (name) =>
            (name !== "taskCreate" && name !== "sessionModelChange") ||
            accepted.includes("appState"),
    );
}

/** Task targets exist only for desktops that negotiated AppState. */
function namesTask(context: LiveDesktopContext): boolean {
    return context.activeTarget?.kind === "task";
}

function terminal(session: LiveSession): boolean {
    return session.status === "closed" || session.status === "failed";
}
function sessionKey(target: LiveSessionRef): string {
    return JSON.stringify([target.connectionId, target.groupId, target.sessionId]);
}
function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
