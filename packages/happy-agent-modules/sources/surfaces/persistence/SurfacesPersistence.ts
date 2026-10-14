import {
    AgentKV,
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentPersistence,
    type AgentRecord,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** Module-owned AgentKV storage. Current values and immutable revisions use disjoint prefixes. */
export class SurfacesPersistence implements AgentPersistence {
    constructor(readonly database: AgentDatabase) {}
    transaction<T>(ctx: Context, work: (ctx: Context) => Promise<T>): Promise<T> {
        return ctx.inTx(work);
    }
    async load(_ctx: Context): Promise<readonly AgentRecord[]> {
        throw new Error("Surfaces do not store agent records.");
    }
    async append(_ctx: Context, _record: AgentRecord): Promise<void> {
        throw new Error("Surfaces do not store agent records.");
    }
    async clearRecords(_ctx: Context): Promise<void> {
        throw new Error("Surfaces do not store agent records.");
    }
    async readValues(ctx: Context, prefix: string) {
        const rows = await agentDatabaseRows<{ key: string; value_json: string }>(
            ctx.db,
            sql`SELECT key, value_json FROM happy_agent_surfaces WHERE key >= ${prefix} AND key < ${prefix + "\uffff"} ORDER BY key`,
        );
        return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value_json) as unknown }));
    }
    async queryPage(
        ctx: Context,
        prefix: string,
        after: string,
        limit: number,
    ): Promise<unknown[]> {
        const rows = await agentDatabaseRows<{ value_json: string }>(
            ctx.db,
            sql`SELECT value_json FROM happy_agent_surfaces WHERE key >= ${prefix} AND key < ${prefix + "\uffff"} AND key > ${prefix + after} ORDER BY key LIMIT ${limit}`,
        );
        return rows.map((row) => JSON.parse(row.value_json) as unknown);
    }
    async writeValue(ctx: Context, key: string, value: unknown): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surfaces (key, value_json) VALUES (${key}, ${JSON.stringify(value)}) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        );
    }
    async writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean> {
        const rows = await agentDatabaseRows<{ key: string }>(
            ctx.db,
            sql`INSERT INTO happy_agent_surfaces (key, value_json) VALUES (${key}, ${JSON.stringify(value)}) ON CONFLICT(key) DO NOTHING RETURNING key`,
        );
        return rows.length === 1;
    }
    async deleteValue(ctx: Context, key: string): Promise<void> {
        await agentDatabaseRun(ctx.db, sql`DELETE FROM happy_agent_surfaces WHERE key = ${key}`);
    }
    kv(): AgentKV {
        return new AgentKV(this, "");
    }
}

export const surfacesMigrations: readonly AgentModuleMigration[] = [
    [
        "001-surfaces",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surfaces (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
            );
        },
    ],
];
