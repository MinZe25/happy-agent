import type { AnyAgentTool } from "@slopus/happy-agent-base";
import type { TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { ExportedBotsModule } from "./ExportedBotsModule.js";

/**
 * A failure talking to a chat service. Its message is written for a person and never contains a
 * credential, so it is safe to log and to show in an export's status.
 */
export class ExportedBotError extends Error {
    /** Retrying the same request cannot succeed, such as a rejected token or a missing chat. */
    readonly permanent: boolean;
    /** How long the service asked the caller to wait before trying again. */
    readonly retryAfterMs: number | undefined;

    constructor(message: string, permanent: boolean, retryAfterMs?: number) {
        super(message);
        this.name = "ExportedBotError";
        this.permanent = permanent;
        this.retryAfterMs = retryAfterMs;
    }
}

/** How an export's service is named to people and agents. */
export interface ExportedBotNames {
    /** The service as people know it, such as "Telegram". */
    readonly service: string;
    /** What one of the service's accounts is called, such as "Telegram bot". */
    readonly account: string;
}

/** A file a person sent: a path on this machine that the adapter or its bridge wrote. */
export interface InboundAttachment {
    readonly path: string;
    readonly mimeType?: string;
    readonly name?: string;
}

/** One message a person sent to the bot, in the service's own identifiers as strings. */
export interface InboundMessage {
    /** Unique for the export's account, forever; it makes taking the message in idempotent. */
    readonly id: string;
    readonly chatId: string;
    /** Whether this is a one-to-one chat. Only those reach a conversation. */
    readonly direct: boolean;
    readonly sender: {
        readonly id: string;
        readonly name?: string;
        readonly username?: string;
        readonly isBot: boolean;
    };
    readonly text: string;
    readonly attachments?: readonly InboundAttachment[];
}

/** Something to take in: a message, a new position in the account's stream, or both. */
export interface InboundEvent {
    readonly message?: InboundMessage;
    /** Opaque resume state, saved in the transaction that takes the message in. */
    readonly state?: string;
}

/** What became of an event. A rejected one was not delivered and never will be. */
export interface InboundOutcome {
    readonly rejected?: string;
}

/** Why a running export is being stopped. */
export type ExportedBotStopReason =
    /** Removed, or its settings such as its credentials changed. */
    | "changed"
    /** Turned off, or its bot is archived. */
    | "unavailable";

/** One export's connection, handed to its adapter's `run` for as long as the export runs. */
export interface ExportedBotConnection<Settings> {
    readonly botId: string;
    readonly account: string;
    readonly settings: Settings;
    /** Why the export is stopping, once its lifetime has been aborted on purpose. */
    readonly stopReason: ExportedBotStopReason | undefined;
    /** The bot's current name, for a service that shows it. */
    botName(ctx: Context): Promise<string>;
    /** The resume state this account last saved, or undefined before the first. */
    readState(ctx: Context): Promise<string | undefined>;
    /** Name the export's own account on the service, such as a bot's username. */
    identify(username: string | undefined): void;
    /** Messages are flowing. */
    connected(): void;
    /** The export is ready, but nothing on the service's side is connected yet. */
    waiting(): void;
    /** Something went wrong; the status shows it until the export is connected again. */
    failed(error: unknown): void;
    /** Whether a sender may talk to the bot now, so files are fetched only for them. */
    allows(ctx: Context, userId: string): Promise<boolean>;
    /**
     * Take in one event. Resolves after commit, which is when a push service should be
     * acknowledged. Failures are retried here; an event that keeps failing is logged, skipped,
     * and resolves as rejected. Rejects only when the export is stopping.
     */
    receive(ctx: Context, event: InboundEvent): Promise<InboundOutcome>;
}

/** Where a reply goes: one saved export and one person's chat. */
export interface ExportedBotEndpoint<Settings> {
    readonly botId: string;
    readonly account: string;
    readonly settings: Settings;
}

export interface ExportedBotRecipient {
    readonly userId: string;
    readonly chatId: string;
}

/** A file the bot attached to a reply: a read-only snapshot on this machine. */
export interface ExportedBotReplyAttachment {
    readonly path: string;
    readonly mimeType: string;
    readonly name: string;
    readonly size: number;
    /** Whether it decoded as a picture, rather than merely being named like one. */
    readonly image: boolean;
}

export interface ExportedBotReply {
    readonly text?: string;
    readonly attachments?: readonly ExportedBotReplyAttachment[];
}

/** "Typing…" while a conversation is working. Best effort and never durable. */
export interface ExportedBotTyping<Settings> {
    /** How often the indicator is renewed at most. */
    readonly intervalMs: number;
    show(
        ctx: Context,
        endpoint: ExportedBotEndpoint<Settings>,
        to: ExportedBotRecipient,
    ): Promise<void>;
}

/** A socket a service opened to Happy, as the API hands it over. */
export interface ExportedBotSocket {
    send(text: string): void;
    close(code: number, reason: string): void;
    /** Drop the connection without a closing handshake. */
    terminate(): void;
    ping(): void;
    readonly bufferedAmount: number;
}

/** What the API tells the export about its socket. */
export interface ExportedBotSocketBinding {
    /** A text frame, or undefined for a binary one. */
    message(text: string | undefined): void;
    pong(): void;
    closed(): void;
}

/** For a kind whose service connects to Happy rather than the other way round. */
export interface ExportedBotListener<Settings> {
    /** Protocol versions this kind speaks, as the `protocol` query names them. */
    readonly protocols: readonly string[];
    /** The account a presented token names, or undefined when it is not this kind's token. */
    accountOf(token: string): string | undefined;
    /** Whether the token is the one these settings were made for. Constant time. */
    authenticate(settings: Settings, token: string): boolean;
    /** Hand an admitted socket to the account's running connection. */
    attach(account: string, socket: ExportedBotSocket): ExportedBotSocketBinding;
}

/**
 * One kind of exported bot. The module owns everything kinds share — saved exports, allowlists,
 * access requests, guests, conversations, durable replies, typing, and status — and asks the
 * adapter only what is particular to its service: how to keep a connection open, and how to
 * send.
 */
export interface ExportedBotAdapter<Settings = unknown> {
    readonly kind: string;
    /** The stored settings: the service's credentials and anything else one export needs. */
    readonly settingsSchema: TSchema;
    /** How an export with these settings is named. */
    names(settings: Settings): ExportedBotNames;
    /**
     * Where a person's user ID means the same person: the empty string when the service's IDs
     * are global, as Telegram's are, or `account` when they mean something only to it. One
     * person in one scope is one guest in Happy.
     */
    guestScope(account: string): string;
    /** A link people can open to reach the export's account, when the service has one. */
    linkTo?(username: string): string;
    /** What a conversation on this kind is told about how its replies are shown. */
    readonly formattingInstructions: string;
    readonly typing?: ExportedBotTyping<Settings>;
    readonly listener?: ExportedBotListener<Settings>;
    /**
     * Keep one export connected until `ctx` is aborted: poll, hold a socket, or wait for the
     * service to connect, and hand every event to `connection.receive`. Throwing or returning
     * starts it again after a backoff.
     */
    run(ctx: Context, connection: ExportedBotConnection<Settings>): Promise<void>;
    /** Cut a reply into the pieces `send` takes, in order. */
    split(reply: ExportedBotReply): readonly ExportedBotReply[];
    /**
     * Send one piece. `key` is stable across retries of the same piece, so a service that can
     * deduplicate may. Throw an `ExportedBotError`; a permanent one drops the rest of the reply.
     */
    send(
        ctx: Context,
        endpoint: ExportedBotEndpoint<Settings>,
        to: ExportedBotRecipient,
        piece: ExportedBotReply,
        key: string,
    ): Promise<void>;
    /** Remove whatever the kind keeps for an account beyond the saved export. */
    forget?(ctx: Context, account: string): Promise<void>;
    /** The kind's setup tool, given to active admin bots. */
    tools(exportedBots: ExportedBotsModule, actingAgentId: string): readonly AnyAgentTool[];
}
