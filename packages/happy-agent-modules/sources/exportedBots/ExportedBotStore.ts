import { agentDatabaseRows, agentDatabaseRun, cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    allowedUsersSchema,
    exportedBotConversationRecordSchema,
    serviceIdSchema,
    exportedBotRecordSchema,
    exportedBotReplyAttachmentSchema,
    exportedBotSenderRecordSchema,
    heldMessageSchema,
    type ExportedBotConversationRecord,
    type ExportedBotRecord,
    type ExportedBotSenderRecord,
} from "./ExportedBot.js";
import {
    EXPORTED_BOT_CONVERSATIONS_TABLE,
    EXPORTED_BOT_CURSORS_TABLE,
    EXPORTED_BOT_GUESTS_TABLE,
    EXPORTED_BOT_OUTBOX_TABLE,
    EXPORTED_BOT_SENDERS_TABLE,
    EXPORTED_BOTS_TABLE,
} from "./ExportedBotMigrations.js";

interface ExportedBotRow {
    readonly bot_id: string;
    readonly kind: string;
    readonly account: string;
    readonly settings: string;
    readonly allowed_users: string;
    readonly unknown_senders: string;
    readonly enabled: number | string;
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

interface ConversationRow {
    readonly bot_id: string;
    readonly kind: string;
    readonly account: string;
    readonly user_id: string;
    readonly chat_id: string;
    readonly agent_id: string;
    readonly name: string;
    readonly username: string | null;
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

interface SenderRow {
    readonly bot_id: string;
    readonly kind: string;
    readonly account: string;
    readonly user_id: string;
    readonly status: string;
    readonly chat_id: string | null;
    readonly name: string;
    readonly username: string | null;
    readonly message: string | null;
    readonly created_at: number | string;
    readonly updated_at: number | string;
}

interface OutboxRow {
    readonly seq: number | string;
    readonly user_id: string;
    readonly chat_id: string;
    readonly payload: string;
}

/** What a waiting reply says, kept as JSON beside its addressing. */
export const outboxPayloadSchema = Type.Object(
    {
        text: Type.Optional(Type.String({ minLength: 1 })),
        attachments: Type.Optional(Type.Array(exportedBotReplyAttachmentSchema)),
    },
    { additionalProperties: false },
);
export type OutboxPayload = Static<typeof outboxPayloadSchema>;

/** One reply waiting for its service to confirm it, in sequence order. */
export interface OutboxReply {
    readonly seq: number;
    readonly userId: string;
    readonly chatId: string;
    readonly payload: OutboxPayload;
}

export async function queryExportedBots(ctx: Context): Promise<readonly ExportedBotRecord[]> {
    const rows = await agentDatabaseRows<ExportedBotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOTS_TABLE)} ORDER BY created_at, bot_id, kind`,
    );
    return rows.map(exportedBotFromRow);
}

export async function queryExportedBot(
    ctx: Context,
    botId: string,
    kind: string,
): Promise<ExportedBotRecord | undefined> {
    const rows = await agentDatabaseRows<ExportedBotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOTS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : exportedBotFromRow(rows[0]);
}

/** The export using one service account, whichever bot it belongs to. */
export async function queryExportedBotByAccount(
    ctx: Context,
    kind: string,
    account: string,
): Promise<ExportedBotRecord | undefined> {
    const rows = await agentDatabaseRows<ExportedBotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOTS_TABLE)}
            WHERE kind = ${kind} AND account = ${account} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : exportedBotFromRow(rows[0]);
}

/** Insert or replace one bot's export of one kind. */
export async function writeExportedBot(ctx: Context, record: ExportedBotRecord): Promise<void> {
    if (!Value.Check(exportedBotRecordSchema, record)) {
        throw new Error("The export is invalid.");
    }
    const settings = JSON.stringify(record.settings);
    const allowedUsers = JSON.stringify(record.allowedUsers);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(EXPORTED_BOTS_TABLE)}
            (bot_id, kind, account, settings, allowed_users, unknown_senders, enabled, created_at,
                updated_at)
            VALUES (${record.botId}, ${record.kind}, ${record.account}, ${settings},
                ${allowedUsers}, ${record.unknownSenders}, ${record.enabled ? 1 : 0},
                ${record.createdAt}, ${record.updatedAt})
            ON CONFLICT (bot_id, kind) DO UPDATE
            SET account = excluded.account, settings = excluded.settings,
                allowed_users = excluded.allowed_users, unknown_senders = excluded.unknown_senders,
                enabled = excluded.enabled, updated_at = excluded.updated_at`,
    );
}

/** Delete one bot's export of one kind. Its account's resume state stays for a reconnection. */
export async function deleteExportedBot(
    ctx: Context,
    botId: string,
    kind: string,
): Promise<ExportedBotRecord | undefined> {
    const existing = await queryExportedBot(ctx, botId, kind);
    if (existing === undefined) return undefined;
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(EXPORTED_BOTS_TABLE)} WHERE bot_id = ${botId} AND kind = ${kind}`,
    );
    return existing;
}

export async function queryExportedBotSender(
    ctx: Context,
    botId: string,
    kind: string,
    account: string,
    userId: string,
): Promise<ExportedBotSenderRecord | undefined> {
    const rows = await agentDatabaseRows<SenderRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} AND account = ${account}
            AND user_id = ${userId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : senderFromRow(rows[0]);
}

/** An export's waiting and turned-away people, each status oldest first. */
export async function queryExportedBotSenders(
    ctx: Context,
    botId: string,
    kind: string,
    account: string,
    status: ExportedBotSenderRecord["status"],
    limit: number,
): Promise<readonly ExportedBotSenderRecord[]> {
    const rows = await agentDatabaseRows<SenderRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} AND account = ${account}
            AND status = ${status} ORDER BY updated_at, user_id LIMIT ${limit}`,
    );
    return rows.map(senderFromRow);
}

export async function countExportedBotSenders(
    ctx: Context,
    botId: string,
    kind: string,
    account: string,
    status: ExportedBotSenderRecord["status"],
): Promise<number> {
    const rows = await agentDatabaseRows<{ readonly count: number | string }>(
        ctx.db,
        sql`SELECT COUNT(*) AS count FROM ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} AND account = ${account}
            AND status = ${status}`,
    );
    return Number(rows[0]?.count ?? 0);
}

/**
 * Insert or replace one person's request or refusal. Beyond `maxDenied` refusals for an export,
 * the oldest are forgotten, so a flood of strangers cannot grow the table without bound.
 */
export async function writeExportedBotSender(
    ctx: Context,
    record: ExportedBotSenderRecord,
    maxDenied: number,
): Promise<void> {
    if (!Value.Check(exportedBotSenderRecordSchema, record)) {
        throw new Error("The exported bot sender is invalid.");
    }
    const message = record.message === undefined ? null : JSON.stringify(record.message);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
            (bot_id, kind, account, user_id, status, chat_id, name, username, message, created_at,
                updated_at)
            VALUES (${record.botId}, ${record.kind}, ${record.account}, ${record.userId},
                ${record.status}, ${record.chatId ?? null}, ${record.name},
                ${record.username ?? null}, ${message}, ${record.createdAt}, ${record.updatedAt})
            ON CONFLICT (bot_id, kind, account, user_id) DO UPDATE
            SET status = excluded.status, chat_id = excluded.chat_id, name = excluded.name,
                username = excluded.username, message = excluded.message,
                updated_at = excluded.updated_at`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
            WHERE bot_id = ${record.botId} AND kind = ${record.kind}
            AND account = ${record.account} AND status = 'denied' AND user_id NOT IN (
                SELECT user_id FROM ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
                WHERE bot_id = ${record.botId} AND kind = ${record.kind}
                AND account = ${record.account} AND status = 'denied'
                ORDER BY updated_at DESC, user_id LIMIT ${maxDenied}
            )`,
    );
}

export async function deleteExportedBotSender(
    ctx: Context,
    botId: string,
    kind: string,
    account: string,
    userId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} AND account = ${account}
            AND user_id = ${userId}`,
    );
}

/** Forget every request and refusal of one export, when the export itself is removed. */
export async function deleteExportedBotSenders(
    ctx: Context,
    botId: string,
    kind: string,
    account: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} AND account = ${account}`,
    );
}

/** The opaque resume state an account last saved, or undefined before the first. */
export async function queryExportedBotState(
    ctx: Context,
    kind: string,
    account: string,
): Promise<string | undefined> {
    const row = (
        await agentDatabaseRows<{ readonly state: string }>(
            ctx.db,
            sql`SELECT state FROM ${sql.raw(EXPORTED_BOT_CURSORS_TABLE)}
                WHERE kind = ${kind} AND account = ${account} LIMIT 1`,
        )
    )[0];
    return row?.state;
}

export async function writeExportedBotState(
    ctx: Context,
    kind: string,
    account: string,
    state: string,
): Promise<void> {
    if (state.length > 4_096) throw new Error("An export's resume state is too large.");
    const now = Date.now();
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(EXPORTED_BOT_CURSORS_TABLE)} (kind, account, state, updated_at)
            VALUES (${kind}, ${account}, ${state}, ${now})
            ON CONFLICT (kind, account) DO UPDATE
            SET state = excluded.state, updated_at = excluded.updated_at`,
    );
}

export async function queryExportedBotConversation(
    ctx: Context,
    botId: string,
    kind: string,
    account: string,
    userId: string,
): Promise<ExportedBotConversationRecord | undefined> {
    const rows = await agentDatabaseRows<ConversationRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOT_CONVERSATIONS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} AND account = ${account}
            AND user_id = ${userId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : conversationFromRow(rows[0]);
}

export async function queryExportedBotConversationByAgent(
    ctx: Context,
    agentId: string,
): Promise<ExportedBotConversationRecord | undefined> {
    const rows = await agentDatabaseRows<ConversationRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOT_CONVERSATIONS_TABLE)}
            WHERE agent_id = ${agentId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : conversationFromRow(rows[0]);
}

export async function queryExportedBotConversations(
    ctx: Context,
    botId: string,
    kind: string,
    account: string,
): Promise<readonly ExportedBotConversationRecord[]> {
    const rows = await agentDatabaseRows<ConversationRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(EXPORTED_BOT_CONVERSATIONS_TABLE)}
            WHERE bot_id = ${botId} AND kind = ${kind} AND account = ${account}
            ORDER BY created_at, user_id`,
    );
    return rows.map(conversationFromRow);
}

/** Insert or replace one person's routing row, including a move to a new subtask. */
export async function writeExportedBotConversation(
    ctx: Context,
    record: ExportedBotConversationRecord,
): Promise<void> {
    if (!Value.Check(exportedBotConversationRecordSchema, record)) {
        throw new Error("The exported bot conversation is invalid.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(EXPORTED_BOT_CONVERSATIONS_TABLE)}
            (bot_id, kind, account, user_id, chat_id, agent_id, name, username, created_at, updated_at)
            VALUES (${record.botId}, ${record.kind}, ${record.account}, ${record.userId},
                ${record.chatId}, ${record.agentId}, ${record.name},
                ${record.username ?? null}, ${record.createdAt}, ${record.updatedAt})
            ON CONFLICT (bot_id, kind, account, user_id) DO UPDATE
            SET chat_id = excluded.chat_id, agent_id = excluded.agent_id, name = excluded.name,
                username = excluded.username, created_at = excluded.created_at,
                updated_at = excluded.updated_at`,
    );
}

/**
 * Queue one reply for an account, once per key: writing the same key again changes nothing, so a
 * reply whose sending was interrupted is not queued twice. Beyond `limit` waiting replies the
 * oldest are dropped, so a service that never comes back cannot grow the table without bound.
 */
export async function insertOutboxReply(
    ctx: Context,
    reply: {
        readonly kind: string;
        readonly account: string;
        readonly key: string;
        readonly userId: string;
        readonly chatId: string;
        readonly payload: OutboxPayload;
    },
    limit: number,
): Promise<void> {
    if (
        !Value.Check(outboxPayloadSchema, reply.payload) ||
        !Value.Check(serviceIdSchema, reply.userId) ||
        !Value.Check(serviceIdSchema, reply.chatId)
    ) {
        throw new Error("The waiting reply is invalid.");
    }
    const payload = JSON.stringify(reply.payload);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(EXPORTED_BOT_OUTBOX_TABLE)}
            (kind, account, reply_key, user_id, chat_id, payload, created_at)
            VALUES (${reply.kind}, ${reply.account}, ${reply.key}, ${reply.userId},
                ${reply.chatId}, ${payload}, ${Date.now()})
            ON CONFLICT (kind, account, reply_key) DO NOTHING`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(EXPORTED_BOT_OUTBOX_TABLE)}
            WHERE kind = ${reply.kind} AND account = ${reply.account} AND seq NOT IN (
                SELECT seq FROM ${sql.raw(EXPORTED_BOT_OUTBOX_TABLE)}
                WHERE kind = ${reply.kind} AND account = ${reply.account}
                ORDER BY seq DESC LIMIT ${limit}
            )`,
    );
}

/** Waiting replies after `afterSeq`, oldest first. */
export async function queryOutboxReplies(
    ctx: Context,
    kind: string,
    account: string,
    afterSeq: number,
    limit: number,
): Promise<readonly OutboxReply[]> {
    const rows = await agentDatabaseRows<OutboxRow>(
        ctx.db,
        sql`SELECT seq, user_id, chat_id, payload FROM ${sql.raw(EXPORTED_BOT_OUTBOX_TABLE)}
            WHERE kind = ${kind} AND account = ${account} AND seq > ${afterSeq}
            ORDER BY seq LIMIT ${limit}`,
    );
    return rows.map((row) => {
        let payload: unknown;
        try {
            payload = JSON.parse(row.payload);
        } catch {
            payload = undefined;
        }
        const seq = Number(row.seq);
        if (!Number.isSafeInteger(seq) || !Value.Check(outboxPayloadSchema, payload)) {
            throw new Error("Exported bot reply storage contains an invalid row.");
        }
        return { seq, userId: row.user_id, chatId: row.chat_id, payload };
    });
}

export async function deleteOutboxReply(
    ctx: Context,
    kind: string,
    account: string,
    seq: number,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(EXPORTED_BOT_OUTBOX_TABLE)}
            WHERE kind = ${kind} AND account = ${account} AND seq = ${seq}`,
    );
}

export async function deleteOutbox(ctx: Context, kind: string, account: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(EXPORTED_BOT_OUTBOX_TABLE)}
            WHERE kind = ${kind} AND account = ${account}`,
    );
}

/** Who a person on a service is in Happy, if they are anyone yet. */
export async function queryGuestUserId(
    ctx: Context,
    kind: string,
    scope: string,
    serviceUserId: string,
): Promise<string | undefined> {
    const rows = await agentDatabaseRows<{ readonly user_id: unknown }>(
        ctx.db,
        sql`SELECT user_id FROM ${sql.raw(EXPORTED_BOT_GUESTS_TABLE)}
            WHERE kind = ${kind} AND scope = ${scope} AND service_user_id = ${serviceUserId}`,
    );
    const userId = rows[0]?.user_id;
    if (userId === undefined) return undefined;
    if (!Value.Check(cuid2Schema, userId)) {
        throw new Error("Exported bot guest storage contains an invalid user ID.");
    }
    return userId;
}

/** Remember which guest user a person on a service is. A person is mapped once, forever. */
export async function writeGuestUserId(
    ctx: Context,
    kind: string,
    scope: string,
    serviceUserId: string,
    userId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(EXPORTED_BOT_GUESTS_TABLE)}
            (kind, scope, service_user_id, user_id, created_at)
            VALUES (${kind}, ${scope}, ${serviceUserId}, ${userId}, ${Date.now()})`,
    );
}

function conversationFromRow(row: ConversationRow): ExportedBotConversationRecord {
    const record = {
        botId: row.bot_id,
        kind: row.kind,
        account: row.account,
        userId: row.user_id,
        chatId: row.chat_id,
        agentId: row.agent_id,
        name: row.name,
        ...(row.username === null ? {} : { username: row.username }),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
    if (!Value.Check(exportedBotConversationRecordSchema, record)) {
        throw new Error("Exported bot conversation storage contains an invalid row.");
    }
    return record;
}

function senderFromRow(row: SenderRow): ExportedBotSenderRecord {
    const message = row.message === null ? undefined : parseJson(row.message);
    if (message !== undefined && !Value.Check(heldMessageSchema, message)) {
        throw new Error("Exported bot sender storage contains an invalid message.");
    }
    const record = {
        botId: row.bot_id,
        kind: row.kind,
        account: row.account,
        userId: row.user_id,
        status: row.status,
        ...(row.chat_id === null ? {} : { chatId: row.chat_id }),
        name: row.name,
        ...(row.username === null ? {} : { username: row.username }),
        ...(message === undefined ? {} : { message }),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
    if (!Value.Check(exportedBotSenderRecordSchema, record)) {
        throw new Error("Exported bot sender storage contains an invalid row.");
    }
    return record;
}

function exportedBotFromRow(row: ExportedBotRow): ExportedBotRecord {
    const settings = parseJson(row.settings);
    const allowedUsers = parseJson(row.allowed_users);
    if (settings === undefined || !Value.Check(allowedUsersSchema, allowedUsers)) {
        throw new Error("Exported bot storage contains invalid settings.");
    }
    const record = {
        botId: row.bot_id,
        kind: row.kind,
        account: row.account,
        settings,
        allowedUsers,
        unknownSenders: row.unknown_senders,
        enabled: Number(row.enabled) === 1,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
    if (!Value.Check(exportedBotRecordSchema, record)) {
        throw new Error("Exported bot storage contains an invalid row.");
    }
    return record;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
