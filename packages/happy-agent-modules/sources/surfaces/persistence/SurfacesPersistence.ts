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
    /** Append one change to a document's permanent log; a taken `seq` is an error. */
    async appendDocumentChange(ctx: Context, change: StoredDocumentChange): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surface_document_changes (surface_id, seq, change, entry_json, mutation_id) VALUES (${change.surfaceId}, ${change.seq}, ${change.change}, ${JSON.stringify(change.entry)}, ${change.mutationId})`,
        );
    }
    async documentSeqForMutation(
        ctx: Context,
        surfaceId: string,
        mutationId: string,
    ): Promise<number | undefined> {
        const rows = await agentDatabaseRows<{ seq: number }>(
            ctx.db,
            sql`SELECT seq FROM happy_agent_surface_document_changes WHERE surface_id = ${surfaceId} AND mutation_id = ${mutationId}`,
        );
        return rows[0] === undefined ? undefined : Number(rows[0].seq);
    }
    /** The change bytes of `after < seq <= through`, oldest first. */
    async documentChanges(
        ctx: Context,
        surfaceId: string,
        after: number,
        through: number,
    ): Promise<string[]> {
        const rows = await agentDatabaseRows<{ change: string }>(
            ctx.db,
            sql`SELECT change FROM happy_agent_surface_document_changes WHERE surface_id = ${surfaceId} AND seq > ${after} AND seq <= ${through} ORDER BY seq`,
        );
        return rows.map((row) => row.change);
    }
    /** Log entries without change bytes, oldest first. */
    async documentEntries(
        ctx: Context,
        surfaceId: string,
        after: number,
        limit: number,
    ): Promise<unknown[]> {
        const rows = await agentDatabaseRows<{ entry_json: string }>(
            ctx.db,
            sql`SELECT entry_json FROM happy_agent_surface_document_changes WHERE surface_id = ${surfaceId} AND seq > ${after} ORDER BY seq LIMIT ${limit}`,
        );
        return rows.map((row) => JSON.parse(row.entry_json) as unknown);
    }
    async writeDocumentSnapshot(
        ctx: Context,
        surfaceId: string,
        seq: number,
        state: string,
    ): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surface_document_snapshots (surface_id, seq, state) VALUES (${surfaceId}, ${seq}, ${state})`,
        );
    }
    /** The latest snapshot taken at or before `seq`. */
    async documentSnapshot(
        ctx: Context,
        surfaceId: string,
        seq: number,
    ): Promise<{ seq: number; state: string } | undefined> {
        const rows = await agentDatabaseRows<{ seq: number; state: string }>(
            ctx.db,
            sql`SELECT seq, state FROM happy_agent_surface_document_snapshots WHERE surface_id = ${surfaceId} AND seq <= ${seq} ORDER BY seq DESC LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : { seq: Number(row.seq), state: row.state };
    }
}

export type StoredDocumentChange = {
    readonly surfaceId: string;
    readonly seq: number;
    /** The Yjs update, base64. */
    readonly change: string;
    readonly entry: unknown;
    readonly mutationId: string | null;
};

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
    [
        "002-surface-documents",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surface_document_changes (surface_id TEXT NOT NULL, seq INTEGER NOT NULL, change TEXT NOT NULL, entry_json TEXT NOT NULL, mutation_id TEXT, PRIMARY KEY (surface_id, seq))`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX happy_agent_surface_document_mutations ON happy_agent_surface_document_changes (surface_id, mutation_id) WHERE mutation_id IS NOT NULL`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surface_document_snapshots (surface_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (surface_id, seq))`,
            );
        },
    ],
];
