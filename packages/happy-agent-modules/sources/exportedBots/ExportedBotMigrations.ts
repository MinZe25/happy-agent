import { agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

/** Each bot's export to an outside chat service, at most one of each kind. */
export const EXPORTED_BOTS_TABLE = "happy_agent_module_exported_bots";
/** How far each service account's stream has been taken in, in the kind's own terms. */
export const EXPORTED_BOT_CURSORS_TABLE = "happy_agent_module_exported_bot_cursors";
/** Which subtask holds each person's conversation with an exported bot. */
export const EXPORTED_BOT_CONVERSATIONS_TABLE = "happy_agent_module_exported_bot_conversations";
/** People outside an allowlist who are waiting to be let in, or were turned away. */
export const EXPORTED_BOT_SENDERS_TABLE = "happy_agent_module_exported_bot_senders";
/** Replies waiting for a service that connects to Happy to confirm it delivered them. */
export const EXPORTED_BOT_OUTBOX_TABLE = "happy_agent_module_exported_bot_outbox";
/** The guest user each person on a service is in Happy. */
export const EXPORTED_BOT_GUESTS_TABLE = "happy_agent_module_exported_bot_guests";

export const exportedBotMigrations = [
    [
        "001-exported-bots",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            // `settings` holds the kind's own fields as JSON, validated against that kind's
            // schema on every use. One service account serves one bot, since a service lets
            // only one reader take its messages. Every identifier from a service is TEXT.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(EXPORTED_BOTS_TABLE)} (
                    bot_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    account TEXT NOT NULL,
                    settings TEXT NOT NULL,
                    allowed_users TEXT NOT NULL,
                    unknown_senders TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    PRIMARY KEY (bot_id, kind),
                    UNIQUE (kind, account)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(EXPORTED_BOT_CURSORS_TABLE)} (
                    kind TEXT NOT NULL,
                    account TEXT NOT NULL,
                    state TEXT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    PRIMARY KEY (kind, account)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(EXPORTED_BOT_CONVERSATIONS_TABLE)} (
                    bot_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    account TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    username TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    PRIMARY KEY (bot_id, kind, account, user_id)
                )`,
            );
            // A pending request holds the person's first message until the user decides; a
            // denied person's row only remembers to stay silent.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(EXPORTED_BOT_SENDERS_TABLE)} (
                    bot_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    account TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    chat_id TEXT,
                    name TEXT NOT NULL,
                    username TEXT,
                    message TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    PRIMARY KEY (bot_id, kind, account, user_id)
                )`,
            );
            // AUTOINCREMENT, so a sequence number is never handed out twice, even after every
            // reply before it was confirmed and deleted.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(EXPORTED_BOT_OUTBOX_TABLE)} (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    account TEXT NOT NULL,
                    reply_key TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at BIGINT NOT NULL,
                    UNIQUE (kind, account, reply_key)
                )`,
            );
            // `scope` is empty where a service's user IDs mean the same person everywhere, as
            // Telegram's do, and the export's account where they mean something only within it.
            // A guest outlives every export and allowlist that let them in.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(EXPORTED_BOT_GUESTS_TABLE)} (
                    kind TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    service_user_id TEXT NOT NULL,
                    user_id TEXT NOT NULL UNIQUE,
                    created_at BIGINT NOT NULL,
                    PRIMARY KEY (kind, scope, service_user_id)
                )`,
            );
        },
    ],
] as const;
