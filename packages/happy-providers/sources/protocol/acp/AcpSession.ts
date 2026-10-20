import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import type { Context } from "@steve.kite/stdlib";

import { BaseSession } from "@/core/BaseSession.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { SessionUsage } from "@/core/SessionUsage.js";
import type {
    AcpConfigOptionValue,
    AcpPermissionMode,
    AcpProviderOptions,
    AcpTurnEnvironment,
} from "@/protocol/acp/AcpProvider.js";
import { acpCompactWithAgent } from "@/protocol/acp/impl/acpCompactWithAgent.js";
import type { AcpConnection } from "@/protocol/acp/AcpConnection.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import {
    acpCatchUpPrompt,
    acpPromptFromMessages,
    acpReplayPrompt,
} from "@/protocol/acp/impl/acpPromptFromMessages.js";
import { ACP_BRIDGE_NAME, AcpResponseEvents } from "@/protocol/acp/impl/acpResponseEvents.js";
import {
    acpSessionRecordRead,
    acpSessionRecordWrite,
    acpTranscriptFingerprint,
    type AcpSessionRecord,
} from "@/protocol/acp/impl/acpSessionStore.js";
import {
    acpBridgeResult,
    AcpToolBridgeServer,
    type AcpBridgeCall,
} from "@/protocol/acp/impl/AcpToolBridgeServer.js";
import { AcpTurnQueue } from "@/protocol/acp/impl/AcpTurnQueue.js";
import { acpAcceptsConfigValue, acpConfigOptionId } from "@/protocol/acp/impl/acpConfigOptions.js";

export interface AcpSessionOptions extends AcpProviderOptions {
    readonly instructions: string;
    readonly tools: readonly SessionTool[];
}

const PREVIOUS_PROMPT_GRACE_MS = 10_000;
/** How long a cancelled agent gets to end its prompt and save its session before it is stopped. */
const CANCEL_GRACE_MS = 2_000;
/** The longest a new session waits for the one before it to bind its native conversation. */
const NEW_SESSION_GATE_MS = 60_000;
const ABORTED = Symbol("acp_aborted");
const STEERED = Symbol("acp_steered");

/** Updates an agent can only send from inside a turn, once it has a conversation to report. */
const TURN_CONTENT_UPDATES = new Set<string>([
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
]);

/** The first prompt of the last new session started per agent profile, for agents that need it. */
const newSessionPrompts = new WeakMap<object, Promise<unknown>>();

type TurnItem =
    | { readonly kind: "update"; readonly update: acp.SessionUpdate }
    | { readonly kind: "bridge_call"; readonly call: AcpBridgeCall }
    | { readonly kind: "prompt_end"; readonly response: acp.PromptResponse }
    | { readonly kind: "prompt_error"; readonly error: unknown };

/**
 * One foreign prompt in flight. It outlives a Happy response whenever the agent calls a bridged
 * Happy tool: the response ends with that call, Agent Base executes it, and the next run answers
 * the still-open MCP request and keeps draining this same prompt.
 */
interface LiveTurn {
    readonly items: AcpTurnQueue<TurnItem>;
    /** Bridged calls handed to the caller whose results have not arrived yet. */
    readonly awaiting: Map<string, AcpBridgeCall>;
    /** Input that arrived while the prompt was still open; sent as the next prompt. */
    readonly deferred: SessionMessage[];
    /**
     * The Happy response ended for steering while this prompt kept running. The next run hands
     * the steering to the agent's own loop and keeps draining this prompt.
     */
    steering: boolean;
    /**
     * The read a response left waiting when steering or an abort won the race. The next response
     * takes it over, so the item it receives is not lost.
     */
    reading: Promise<TurnItem> | undefined;
}

/**
 * A Happy conversation continued inside a foreign agent's own ACP session.
 *
 * Each run sends only the input the foreign session has not seen yet. When the foreign session
 * cannot be continued — it was lost, or Happy's transcript no longer matches what it saw — a new
 * one is opened and given Happy's instructions and transcript to continue from.
 */
export class AcpSession extends BaseSession {
    readonly #options: AcpSessionOptions;
    readonly #bridgedTools: readonly SessionTool[];
    #connection: AcpConnection | undefined;
    #connecting: Promise<AcpConnection> | undefined;
    #acpSessionId: string | undefined;
    #cwd: string | undefined;
    #record: AcpSessionRecord | undefined;
    #recordLoaded = false;
    #turn: LiveTurn | undefined;
    #previousPrompt: Promise<unknown> = Promise.resolve();
    /** Settles once a stopped agent process has exited, so its successor never overlaps it. */
    #stopping: Promise<void> = Promise.resolve();
    #replaying = false;
    /** Whether the foreign session was opened by this run and has not been prompted yet. */
    #unprompted = false;
    /** Lets the next new session start once this one's agent has bound its conversation. */
    #releaseNewSession: (() => void) | undefined;
    #permissionMode: AcpPermissionMode | undefined;
    #bridge: AcpToolBridgeServer | undefined;
    readonly #applied = new Map<string, string | boolean>();
    /** The configuration options the foreign session last advertised. */
    #advertised: acp.SessionConfigOption[] | undefined;
    readonly #closedCalls = new Set<string>();
    #contextUsed = 0;
    #destroyed = false;

    constructor(id: string, options: AcpSessionOptions) {
        super(id);
        this.#options = options;
        // Provider-owned server tools stay with the provider that owns them.
        this.#bridgedTools = options.tools.filter((tool) => tool.server === undefined);
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        // A consumer stops a response by returning its iterator. An async generator only honors
        // that at its next `yield`, and a foreign agent can stay silent for minutes inside its own
        // command, so returning also signals the turn directly.
        const stopped = new AbortController();
        const lifetime =
            ctx.lifetime === undefined
                ? stopped.signal
                : AbortSignal.any([ctx.lifetime, stopped.signal]);
        const inner = this.#stream(ctx, lifetime, request);
        return {
            [Symbol.asyncIterator]: () => ({
                next: () => inner.next(),
                return: async (value?: unknown) => {
                    stopped.abort();
                    return await inner.return(value as undefined);
                },
            }),
        };
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const result = await acpCompactWithAgent(ctx, options, (runCtx, request) =>
            this.#stream(runCtx, runCtx.lifetime, request),
        );
        if (result.status === "completed") {
            // The foreign session still holds the long context; the next run opens a new one
            // from the summary instead.
            this.#acpSessionId = undefined;
            this.#record = undefined;
        } else {
            this.#abandonTurn();
        }
        return result;
    }

    destroy(): void {
        this.#destroyed = true;
        this.#abandonTurn();
        this.#bridge?.close();
        this.#bridge = undefined;
        const connection = this.#connection;
        this.#connection = undefined;
        this.#connecting = undefined;
        connection?.terminate();
    }

    async *#stream(
        ctx: Context,
        signal: AbortSignal | undefined,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        if (signal?.aborted) {
            yield { type: "done", state: "cancelled" };
            return;
        }
        const environment = this.#options.environment(ctx);
        this.#permissionMode = environment.permissionMode;
        yield { type: "block_start" };

        let connection: AcpConnection | undefined;
        let turn: LiveTurn;
        try {
            connection = await this.#connect(environment);
            await this.#loadRecord();
            const live = this.#turn;
            if (
                live !== undefined &&
                (live.awaiting.size > 0 || live.steering) &&
                this.#acpSessionId !== undefined
            ) {
                turn = live;
                await this.#continueTurn(connection, turn, request.context.messages);
            } else {
                this.#abandonTurn();
                await settleWithin(this.#previousPrompt, PREVIOUS_PROMPT_GRACE_MS);
                const prompt = await this.#prepareSession(connection, environment, request);
                await this.#applyOptions(connection, request, environment);
                turn = this.#startTurn(connection, prompt);
            }
        } catch (error) {
            yield { type: "block_stop" };
            yield errorDone(error, connection?.stderr() ?? "");
            return;
        }

        const events = new AcpResponseEvents(this.#closedCalls);
        const aborted = abortPromise(signal);
        // Steering ends this response so Agent Base can deliver the new input on the next run.
        const steered = abortPromise(request.steered).then((): typeof STEERED => STEERED);
        let finished = false;
        try {
            for (;;) {
                turn.reading ??= turn.items.next();
                const item = await Promise.race([turn.reading, aborted, steered]);
                if (item !== ABORTED && item !== STEERED) turn.reading = undefined;
                if (item === STEERED) {
                    yield* events.close();
                    yield* events.settleAll();
                    await this.#commit(request.context.messages);
                    // An agent whose loop takes input mid-turn keeps going; the steering joins it
                    // on the next run. Any other agent is interrupted.
                    if (connection.conn.steer !== undefined) turn.steering = true;
                    else this.#stopTurn(connection);
                    finished = true;
                    const usage = this.#usage(undefined, events.outputCharacters);
                    yield { type: "token_usage", usage };
                    yield { type: "block_stop" };
                    yield {
                        type: "done",
                        state: "normal",
                        tokens: { input: usage.input, output: usage.output },
                    };
                    return;
                }
                // A consumer stops reading at `done`, so everything that must happen for a turn
                // happens before that event is yielded.
                if (item === ABORTED) {
                    yield* events.close();
                    yield* events.settleAll();
                    // The agent already saw this turn's input, so the next run sends only what is
                    // new rather than repeating a request the user stopped.
                    await this.#commit(request.context.messages);
                    this.#stopTurn(connection);
                    finished = true;
                    yield { type: "block_stop" };
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                if (item.kind === "update") {
                    yield* events.update(item.update);
                    continue;
                }
                if (item.kind === "prompt_end" && turn.deferred.length > 0) {
                    const next = turn.deferred.splice(0);
                    this.#sendPrompt(
                        connection,
                        turn,
                        acpPromptFromMessages(next, images(connection)),
                    );
                    continue;
                }
                yield* events.close();
                yield* events.settleAll();
                if (item.kind === "prompt_error") {
                    this.#turn = undefined;
                    finished = true;
                    yield { type: "block_stop" };
                    yield errorDone(item.error, connection.stderr());
                    return;
                }
                if (item.kind === "bridge_call") {
                    const { call } = item;
                    turn.awaiting.set(call.callId, call);
                    yield {
                        type: "toolcall_start",
                        callId: call.callId,
                        name: call.tool.name,
                        ...(call.tool.namespace === undefined
                            ? {}
                            : { namespace: call.tool.namespace }),
                    };
                    yield { type: "toolcall_end", callId: call.callId, arguments: call.arguments };
                }
                const response = item.kind === "prompt_end" ? item.response : undefined;
                if (response !== undefined) this.#turn = undefined;
                const usage = this.#usage(response, events.outputCharacters);
                const tokens = { input: usage.input, output: usage.output };
                await this.#commit(request.context.messages);
                finished = true;
                yield { type: "token_usage", usage };
                yield { type: "block_stop" };
                if (response === undefined) {
                    yield { type: "done", state: "tool_call", tokens };
                } else if (response.stopReason === "cancelled") {
                    yield { type: "done", state: "cancelled" };
                } else if (
                    response.stopReason === "max_tokens" ||
                    response.stopReason === "max_turn_requests"
                ) {
                    yield { type: "done", state: "length", tokens };
                } else {
                    yield { type: "done", state: "normal", tokens, endTurn: true };
                }
                return;
            }
        } finally {
            // A consumer that stopped reading mid-turn stopped it: this is how Agent Base aborts.
            if (!finished) {
                void this.#commit(request.context.messages).catch(() => undefined);
                this.#stopTurn(connection);
            }
        }
    }

    /**
     * Continue a prompt that outlived the last Happy response: answer its open MCP requests with
     * the results Agent Base produced, and hand any new input to the agent's loop when it takes
     * input mid-turn, or keep it for the next prompt when it does not.
     */
    async #continueTurn(
        connection: AcpConnection,
        turn: LiveTurn,
        messages: readonly SessionMessage[],
    ): Promise<void> {
        turn.steering = false;
        const input: SessionMessage[] = [];
        for (const message of inputMessages(messages).slice(this.#record?.consumed ?? 0)) {
            const call = message.role === "tool" ? turn.awaiting.get(message.callId) : undefined;
            if (call !== undefined && message.role === "tool") {
                turn.awaiting.delete(message.callId);
                call.resolve(acpBridgeResult(message));
            } else {
                input.push(message);
            }
        }
        const steer = connection.conn.steer;
        const taken =
            input.length > 0 &&
            steer !== undefined &&
            (await steer
                .call(connection.conn, {
                    sessionId: this.#acpSessionId!,
                    prompt: acpPromptFromMessages(input, images(connection)),
                })
                .catch(() => false));
        if (!taken) turn.deferred.push(...input);
        for (const call of turn.awaiting.values()) {
            call.resolve({
                content: [{ type: "text", text: "No result was recorded for this call." }],
                isError: true,
            });
        }
        turn.awaiting.clear();
    }

    async #connect(environment: AcpTurnEnvironment): Promise<AcpConnection> {
        if (this.#destroyed) throw new Error("The agent session was closed.");
        if (this.#connection !== undefined) return this.#connection;
        await this.#stopping;
        if (this.#connection !== undefined) return this.#connection;
        const { connect, launch } = this.#options;
        this.#connecting ??= (
            connect === undefined
                ? acpConnectionSpawn(launch!, environment.cwd, this.#client())
                : connect(environment.cwd, this.#client())
        ).then(
            (connection) => {
                this.#connecting = undefined;
                // Closed while the agent was starting: nothing will ever end it but this.
                if (this.#destroyed) {
                    connection.terminate();
                    throw new Error("The agent session was closed.");
                }
                this.#connection = connection;
                void connection.exited.then((error) => {
                    // A stopped agent was already detached; its exit belongs to no current turn.
                    if (this.#connection !== connection) return;
                    this.#openNewSessionGate();
                    this.#turn?.items.push({ kind: "prompt_error", error });
                    this.#connection = undefined;
                    this.#acpSessionId = undefined;
                    this.#applied.clear();
                });
                return connection;
            },
            (error: unknown) => {
                this.#connecting = undefined;
                throw error;
            },
        );
        return await this.#connecting;
    }

    #client(): acp.Client {
        return {
            requestPermission: async (params) => this.#answerPermission(params),
            sessionUpdate: async (params) => {
                if (this.#replaying || params.sessionId !== this.#acpSessionId) return;
                // Session-level notices arrive before the agent has a conversation; only turn
                // content proves it bound one.
                if (TURN_CONTENT_UPDATES.has(params.update.sessionUpdate)) {
                    this.#openNewSessionGate();
                }
                if (params.update.sessionUpdate === "config_option_update") {
                    this.#advertised = params.update.configOptions;
                }
                if (params.update.sessionUpdate === "usage_update") {
                    this.#contextUsed = params.update.used;
                }
                this.#turn?.items.push({ kind: "update", update: params.update });
            },
        };
    }

    async #loadRecord(): Promise<void> {
        if (this.#recordLoaded) return;
        this.#record = await acpSessionRecordRead(this.#options.stateDirectory, this.id);
        this.#recordLoaded = true;
    }

    /** Open, restore, or keep the foreign session, and return the prompt this run sends. */
    async #prepareSession(
        connection: AcpConnection,
        environment: AcpTurnEnvironment,
        request: SessionRunRequest,
    ): Promise<acp.ContentBlock[]> {
        const messages = request.context.messages;
        const inputs = inputMessages(messages);
        const record = this.#record;
        const continues =
            record !== undefined &&
            record.cwd === environment.cwd &&
            record.consumed <= inputs.length &&
            acpTranscriptFingerprint(inputs.slice(0, record.consumed)) === record.fingerprint;
        if (continues) {
            const delta = acpDeltaPrompt(messages, record.consumed, images(connection));
            if (this.#acpSessionId === record.acpSessionId && this.#cwd === environment.cwd) {
                return delta;
            }
            if (await this.#restoreSession(connection, record, environment)) return delta;
        }

        const response = await connection.conn.newSession({
            cwd: environment.cwd,
            mcpServers: await this.#mcpServers(connection),
            ...(await this.#additionalDirectories()),
        } as acp.NewSessionRequest);
        this.#acpSessionId = response.sessionId;
        this.#advertised = response.configOptions ?? undefined;
        this.#cwd = environment.cwd;
        this.#applied.clear();
        this.#record = undefined;
        this.#unprompted = true;
        let lastResponse = -1;
        messages.forEach((message, index) => {
            if (message.role === "assistant") lastResponse = index;
        });
        return acpReplayPrompt(
            request.context.instructions,
            messages.slice(0, lastResponse + 1),
            messages.slice(lastResponse + 1),
            images(connection),
        );
    }

    async #restoreSession(
        connection: AcpConnection,
        record: AcpSessionRecord,
        environment: AcpTurnEnvironment,
    ): Promise<boolean> {
        const capabilities = connection.init.agentCapabilities;
        const params = {
            sessionId: record.acpSessionId,
            cwd: environment.cwd,
            mcpServers: await this.#mcpServers(connection),
            ...(await this.#additionalDirectories()),
        };
        try {
            if (capabilities?.sessionCapabilities?.resume != null) {
                const resumed = await connection.conn.resumeSession(
                    params as acp.ResumeSessionRequest,
                );
                this.#advertised = resumed.configOptions ?? undefined;
            } else if (capabilities?.loadSession === true) {
                // Loading replays the whole history as notifications; Happy already has it.
                this.#replaying = true;
                try {
                    const loaded = await connection.conn.loadSession(
                        params as acp.LoadSessionRequest,
                    );
                    this.#advertised = loaded.configOptions ?? undefined;
                } finally {
                    this.#replaying = false;
                }
            } else {
                return false;
            }
        } catch {
            return false;
        }
        this.#acpSessionId = record.acpSessionId;
        this.#cwd = environment.cwd;
        this.#applied.clear();
        return true;
    }

    async #applyOptions(
        connection: AcpConnection,
        request: SessionRunRequest,
        environment: AcpTurnEnvironment,
    ): Promise<void> {
        const profile = this.#options.profile;
        const wanted: AcpConfigOptionValue[] = [
            ...(profile?.modelOptions?.(request.model, request.effort) ?? []),
            ...(environment.permissionMode === undefined
                ? []
                : (profile?.permissionOptions?.(environment.permissionMode) ?? [])),
        ];
        for (const option of wanted) {
            const configId = acpConfigOptionId(this.#advertised, option);
            if (configId === undefined) continue;
            if (this.#applied.get(configId) === option.value) continue;
            // A value the agent does not offer, such as a model it no longer serves, would fail
            // the whole turn; the agent keeps its current choice instead.
            if (!acpAcceptsConfigValue(this.#advertised, configId, option.value)) continue;
            const changed = await connection.conn.setSessionConfigOption({
                sessionId: this.#acpSessionId!,
                configId,
                ...(typeof option.value === "boolean"
                    ? { type: "boolean", value: option.value }
                    : { value: option.value }),
            } as acp.SetSessionConfigOptionRequest);
            this.#advertised = changed.configOptions;
            this.#applied.set(configId, option.value);
        }
    }

    async #mcpServers(connection: AcpConnection): Promise<acp.McpServer[]> {
        const bridge = await this.#ensureBridge();
        if (bridge === undefined) return [];
        if (connection.init.agentCapabilities?.mcpCapabilities?.http !== true) return [];
        return [
            {
                type: "http",
                name: ACP_BRIDGE_NAME,
                url: bridge.url,
                headers: Object.entries(bridge.headers).map(([name, value]) => ({ name, value })),
            },
        ];
    }

    /** Agents that ignore ACP `mcpServers` discover the bridge from a private extra directory. */
    async #additionalDirectories(): Promise<{ additionalDirectories?: string[] }> {
        const files = this.#options.profile?.bridgeDirectoryFiles;
        const bridge = await this.#ensureBridge();
        if (files === undefined || bridge === undefined) return {};
        const directory = join(this.#options.stateDirectory, "bridge", encodeURIComponent(this.id));
        for (const file of files({
            name: ACP_BRIDGE_NAME,
            url: bridge.url,
            headers: bridge.headers,
        })) {
            const path = join(directory, file.path);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writeFile(path, file.content, { mode: 0o600 });
        }
        return { additionalDirectories: [directory] };
    }

    async #ensureBridge(): Promise<AcpToolBridgeServer | undefined> {
        if (this.#bridgedTools.length === 0) return undefined;
        this.#bridge ??= await AcpToolBridgeServer.start(this.#bridgedTools, (call) => {
            const turn = this.#turn;
            if (turn === undefined) {
                call.resolve({
                    content: [{ type: "text", text: "No Happy turn is active." }],
                    isError: true,
                });
                return;
            }
            turn.items.push({ kind: "bridge_call", call });
        });
        return this.#bridge;
    }

    #startTurn(connection: AcpConnection, prompt: acp.ContentBlock[]): LiveTurn {
        const turn: LiveTurn = {
            items: new AcpTurnQueue(),
            awaiting: new Map(),
            deferred: [],
            steering: false,
            reading: undefined,
        };
        this.#turn = turn;
        this.#sendPrompt(connection, turn, prompt);
        return turn;
    }

    #sendPrompt(connection: AcpConnection, turn: LiveTurn, prompt: acp.ContentBlock[]): void {
        const sessionId = this.#acpSessionId!;
        const profile = this.#options.profile;
        let send = (): Promise<acp.PromptResponse> => connection.conn.prompt({ sessionId, prompt });
        if (this.#unprompted && profile?.serializeNewSessions === true) {
            // The agent has bound its native conversation once it reports anything, so the next
            // new session waits only for that, never for a whole turn that may itself wait on it.
            const before = newSessionPrompts.get(profile) ?? Promise.resolve();
            let release!: () => void;
            const bound = new Promise<void>((resolve) => (release = resolve));
            this.#releaseNewSession = release;
            newSessionPrompts.set(profile, bound);
            send = async () => {
                // Bounded, so a session that went quiet without ever binding cannot hold every
                // later one forever.
                await settleWithin(before, NEW_SESSION_GATE_MS);
                const response = connection.conn.prompt({ sessionId, prompt });
                void response.finally(release).catch(() => undefined);
                return await response;
            };
        }
        this.#unprompted = false;
        this.#previousPrompt = send().then(
            (response) => turn.items.push({ kind: "prompt_end", response }),
            (error: unknown) => turn.items.push({ kind: "prompt_error", error }),
        );
    }

    #cancelTurn(connection: AcpConnection): void {
        if (this.#turn === undefined) return;
        if (this.#acpSessionId !== undefined) {
            void connection.conn.cancel({ sessionId: this.#acpSessionId }).catch(() => undefined);
        }
        this.#abandonTurn();
    }

    /**
     * Stop means stopped: cancel the prompt, give the agent a moment to end it and save its
     * session, then end the agent and whatever it was still running. The next run starts a new
     * agent process and restores the same foreign session from the record.
     */
    #stopTurn(connection: AcpConnection): void {
        const prompt = this.#previousPrompt;
        // Taken before cancelling: an agent may orphan the command it was running as it cancels.
        const groups = connection.processGroups();
        this.#cancelTurn(connection);
        if (this.#connection === connection) {
            this.#connection = undefined;
            this.#acpSessionId = undefined;
            this.#applied.clear();
        }
        this.#stopping = settleWithin(prompt, CANCEL_GRACE_MS).then(async () => {
            connection.terminate(groups);
            await settleWithin(connection.exited, CANCEL_GRACE_MS);
        });
    }

    #abandonTurn(): void {
        // A new session that will never report anything must not hold back the next one.
        this.#openNewSessionGate();
        const turn = this.#turn;
        this.#turn = undefined;
        if (turn === undefined) return;
        for (const call of turn.awaiting.values()) {
            call.resolve({
                content: [{ type: "text", text: "The Happy turn was cancelled." }],
                isError: true,
            });
        }
        turn.awaiting.clear();
    }

    #openNewSessionGate(): void {
        this.#releaseNewSession?.();
        this.#releaseNewSession = undefined;
    }

    async #commit(messages: readonly SessionMessage[]): Promise<void> {
        if (this.#acpSessionId === undefined || this.#cwd === undefined) return;
        const inputs = inputMessages(messages);
        this.#record = {
            acpSessionId: this.#acpSessionId,
            cwd: this.#cwd,
            consumed: inputs.length,
            fingerprint: acpTranscriptFingerprint(inputs),
        };
        await acpSessionRecordWrite(this.#options.stateDirectory, this.id, this.#record);
    }

    #answerPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
        // The agent asks before acting on its own. Read only refuses; every other mode lets
        // this one action through.
        const allow = this.#permissionMode !== "read_only";
        const option =
            params.options.find(
                (candidate) => candidate.kind === (allow ? "allow_once" : "reject_once"),
            ) ??
            params.options.find((candidate) =>
                candidate.kind.startsWith(allow ? "allow" : "reject"),
            );
        if (option === undefined) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: option.optionId } };
    }

    #usage(response: acp.PromptResponse | undefined, outputCharacters: number): SessionUsage {
        const reported = response?.usage ?? undefined;
        const output = reported?.outputTokens ?? Math.ceil(outputCharacters / 4);
        const input = this.#contextUsed > 0 ? this.#contextUsed : (reported?.inputTokens ?? 0);
        return {
            input,
            output,
            cacheRead: reported?.cachedReadTokens ?? 0,
            cacheWrite: reported?.cachedWriteTokens ?? 0,
            totalTokens: input + output,
        };
    }
}

/** Everything the foreign session consumes. Its own responses are never sent back to it. */
function inputMessages(messages: readonly SessionMessage[]): SessionMessage[] {
    return messages.filter((message) => message.role !== "assistant");
}

/**
 * What a continuing foreign session is sent: the input after the `consumed` it has seen. Its own
 * replies follow that input directly; a reply after any newer input came from somewhere else —
 * another account, harness or model the conversation was switched to — so everything up to the
 * last such reply is passed on as a transcript rather than lost.
 */
function acpDeltaPrompt(
    messages: readonly SessionMessage[],
    consumed: number,
    images: boolean,
): acp.ContentBlock[] {
    let start = 0;
    for (let seen = 0; start < messages.length && seen < consumed; start++) {
        if (messages[start]!.role !== "assistant") seen++;
    }
    while (start < messages.length && messages[start]!.role === "assistant") start++;
    const rest = messages.slice(start);
    const answered = rest.findLastIndex((message) => message.role === "assistant");
    if (answered === -1) return acpPromptFromMessages(rest, images);
    return acpCatchUpPrompt(rest.slice(0, answered + 1), rest.slice(answered + 1), images);
}

function images(connection: AcpConnection): boolean {
    return connection.init.agentCapabilities?.promptCapabilities?.image === true;
}

function errorDone(error: unknown, stderr: string): SessionEvent {
    const message =
        typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
    const tail = stderr.trim().split("\n").slice(-5).join("\n");
    return {
        type: "done",
        state: "error",
        kind: "internal_error",
        message: tail.length === 0 ? message : `${message}\n${tail}`,
    };
}

function abortPromise(signal: AbortSignal | undefined): Promise<typeof ABORTED> {
    return new Promise((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) {
            resolve(ABORTED);
            return;
        }
        signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
    });
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
    await Promise.race([
        promise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, ms).unref()),
    ]);
}
