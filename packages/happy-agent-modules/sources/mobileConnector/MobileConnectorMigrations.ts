import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const MOBILE_DEVICES_TABLE = "happy_agent_mobile_devices";

/**
 * One row per paired phone. `token_hash` is the hex SHA-256 of the 32-byte device token; the
 * token itself is never stored. `owner_id` is the user who created the pairing.
 */
export const mobileConnectorMigrations: readonly AgentModuleMigration[] = [
    [
        "001-mobile-devices",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(MOBILE_DEVICES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${MOBILE_DEVICES_TABLE}_owner`)}
                    ON ${sql.raw(MOBILE_DEVICES_TABLE)} (owner_id, created_at)`,
            );
        },
    ],
];
