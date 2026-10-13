import { agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

export const BOT_SETTINGS_TABLE = "happy_agent_module_bot_settings";
export const BOT_SETTINGS_ROOTS_TABLE = "happy_agent_module_bot_settings_roots";

export const botSettingsMigrations = [
    [
        "001-bot-settings",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            // A bot without a row runs with the defaults, which restrict nothing.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOT_SETTINGS_TABLE)} (
                    bot_agent_id TEXT PRIMARY KEY,
                    settings_json TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    updated_at BIGINT NOT NULL
                )`,
            );
            // A root agent created from inside another agent's tree, such as a task a bot made,
            // stays governed by whoever governs that tree.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOT_SETTINGS_ROOTS_TABLE)} (
                    root_agent_id TEXT PRIMARY KEY,
                    governing_agent_id TEXT NOT NULL
                )`,
            );
        },
    ],
] as const;
