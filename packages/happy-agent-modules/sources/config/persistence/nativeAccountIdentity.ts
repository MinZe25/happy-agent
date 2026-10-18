import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

// Retain existing identities forever; once full, new principals remain unknown. A fixed limit
// bounds optional metadata without evicting identities still referenced by durable history.
export const MAX_NATIVE_ACCOUNT_IDENTITIES = 4_096;
const principalSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\s\\u0000-\\u001f\\u007f]+$",
});
const identitySchema = Type.Object({
    id: Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    }),
});
const countSchema = Type.Object({ count: Type.Integer({ minimum: 0 }) });
export type NativeAccountIdentity = Static<typeof identitySchema>;

export const nativeAccountIdentityMigrations: readonly AgentModuleMigration[] = [
    [
        "001-native-account-identities",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_config_native_accounts (
                    family TEXT NOT NULL,
                    principal TEXT NOT NULL,
                    id TEXT NOT NULL UNIQUE,
                    PRIMARY KEY (family, principal)
                )`,
            );
        },
    ],
];

/** Private installation-wide identity, independent of profile, token, agent and history lifetime. */
export async function nativeAccountIdentity(
    ctx: Context,
    principal: string | undefined,
): Promise<NativeAccountIdentity | null> {
    if (
        principal === undefined ||
        !Value.Check(principalSchema, principal) ||
        Buffer.byteLength(principal, "utf8") > 256 ||
        agentDatabase(ctx) === undefined ||
        ctx.lifetime?.aborted === true
    )
        return null;
    try {
        return await ctx.inTx(async (txCtx) => {
            const existing = await queryIdentity(txCtx, principal);
            if (existing !== null) return existing;
            const rows = await agentDatabaseRows<unknown>(
                txCtx.db,
                sql`SELECT COUNT(*) AS count FROM happy_agent_config_native_accounts`,
            );
            if (!Value.Check(countSchema, rows[0])) {
                throw new Error("The private account identity count is invalid.");
            }
            if (rows[0].count >= MAX_NATIVE_ACCOUNT_IDENTITIES) return null;
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT INTO happy_agent_config_native_accounts (family, principal, id)
                VALUES ('codex', ${principal}, ${randomUUID()})
                ON CONFLICT (family, principal) DO NOTHING`,
            );
            return await queryIdentity(txCtx, principal);
        });
    } catch {
        // Driver errors can include bound SQL parameters. Never serialize the private principal,
        // even as an error cause; a storage failure still fails this operation.
        throw new Error("The private account identity could not be resolved.");
    }
}

async function queryIdentity(
    ctx: Context,
    principal: string,
): Promise<NativeAccountIdentity | null> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT id FROM happy_agent_config_native_accounts
            WHERE family = 'codex' AND principal = ${principal}`,
    );
    if (rows[0] === undefined) return null;
    if (!Value.Check(identitySchema, rows[0])) {
        throw new Error("The private account identity is invalid.");
    }
    return { id: rows[0].id };
}
