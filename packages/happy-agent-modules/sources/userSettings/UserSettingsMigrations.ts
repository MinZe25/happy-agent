import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const USER_SETTINGS_TABLE = "happy_agent_user_settings";
export const USER_SETTINGS_OWNERS_TABLE = "happy_agent_user_settings_owners";

/**
 * One row per key a person has written: a value, or a retained clear with `value_json` NULL.
 * `bytes` is what the row counts toward that person's total, zero for a clear. Each person's row
 * in the owners table keeps the greatest version minted for them and the forgotten-clear horizon.
 */
export const userSettingsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-user-settings",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(USER_SETTINGS_TABLE)} (
                    owner_id TEXT NOT NULL,
                    setting_key TEXT NOT NULL,
                    value_json TEXT,
                    bytes INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    version TEXT NOT NULL,
                    PRIMARY KEY (owner_id, setting_key)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(USER_SETTINGS_OWNERS_TABLE)} (
                    owner_id TEXT PRIMARY KEY,
                    last_version TEXT NOT NULL,
                    horizon INTEGER
                )`,
            );
        },
    ],
];
