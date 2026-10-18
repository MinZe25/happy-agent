import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    openAgentSQLiteDatabase,
    withAgentDatabase,
} from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import {
    MAX_NATIVE_ACCOUNT_IDENTITIES,
    nativeAccountIdentity,
    nativeAccountIdentityMigrations,
} from "../../sources/config/persistence/nativeAccountIdentity.js";

it("creates one opaque installation identity concurrently and preserves it across database reopen", async () => {
    const f = await database();
    try {
        const ids = await Promise.all(
            Array.from({ length: 32 }, () => nativeAccountIdentity(f.ctx, "native-principal-A")),
        );
        expect(ids[0]).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
        expect(new Set(ids.map((id) => id?.id)).size).toBe(1);
        expect(ids[0]?.id).not.toContain("native-principal-A");
        const other = await nativeAccountIdentity(f.ctx, "native-principal-B");
        expect(other).not.toEqual(ids[0]);
        await f.reopen();
        expect(await nativeAccountIdentity(f.ctx, "native-principal-A")).toEqual(ids[0]);
        expect(await nativeAccountIdentity(f.ctx, "native-principal-B")).toEqual(other);
        expect(
            await agentDatabaseRows(
                f.ctx.db,
                sql`SELECT COUNT(*) AS count FROM happy_agent_config_native_accounts`,
            ),
        ).toEqual([{ count: 2 }]);
    } finally {
        await f.close();
    }
});

it("participates in the caller's transaction and rolls back a new identity atomically", async () => {
    const f = await database();
    try {
        const stable = await nativeAccountIdentity(f.ctx, "existing");
        let rolledBack: unknown;
        await expect(
            f.ctx.inTx(async (ctx) => {
                expect(await nativeAccountIdentity(ctx, "existing")).toEqual(stable);
                rolledBack = await nativeAccountIdentity(ctx, "not-committed");
                expect(await nativeAccountIdentity(ctx, "not-committed")).toEqual(rolledBack);
                throw new Error("Roll back the caller.");
            }),
        ).rejects.toThrow("Roll back the caller.");
        expect(
            await agentDatabaseRows(
                f.ctx.db,
                sql`SELECT principal FROM happy_agent_config_native_accounts`,
            ),
        ).toEqual([{ principal: "existing" }]);
        expect(await nativeAccountIdentity(f.ctx, "not-committed")).not.toEqual(rolledBack);
    } finally {
        await f.close();
    }
});

it("retains existing identities at the storage bound and fails closed for new accounts", async () => {
    const f = await database();
    try {
        const stable = await nativeAccountIdentity(f.ctx, "existing");
        await agentDatabaseRun(
            f.ctx.db,
            sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${MAX_NATIVE_ACCOUNT_IDENTITIES - 2})
            INSERT INTO happy_agent_config_native_accounts (family, principal, id)
            SELECT 'codex', 'bounded-' || x, 'private-fixture-' || x FROM n`,
        );
        const newIds = await Promise.all(
            Array.from({ length: 8 }, (_, i) => nativeAccountIdentity(f.ctx, `last-${i}`)),
        );
        expect(newIds.filter((id) => id !== null)).toHaveLength(1);
        expect(await nativeAccountIdentity(f.ctx, "existing")).toEqual(stable);
        expect(await nativeAccountIdentity(f.ctx, "unseen")).toBeNull();
        expect(
            await agentDatabaseRows(
                f.ctx.db,
                sql`SELECT COUNT(*) AS count FROM happy_agent_config_native_accounts`,
            ),
        ).toEqual([{ count: MAX_NATIVE_ACCOUNT_IDENTITIES }]);
    } finally {
        await f.close();
    }
});

it("stores nothing for unknown, invalid, oversized, cancelled or storage-free observations", async () => {
    const f = await database();
    try {
        for (const principal of [undefined, "", " ", "a\nb", "a".repeat(257), "é".repeat(129)])
            expect(await nativeAccountIdentity(f.ctx, principal)).toBeNull();
        const aborted = new AbortController();
        aborted.abort();
        const { withLifetime } = await import("@steve.kite/stdlib");
        expect(
            await nativeAccountIdentity(withLifetime(f.ctx, aborted.signal), "cancelled"),
        ).toBeNull();
        expect(await nativeAccountIdentity(createRootContext(), "without-storage")).toBeNull();
        expect(
            await agentDatabaseRows(
                f.ctx.db,
                sql`SELECT COUNT(*) AS count FROM happy_agent_config_native_accounts`,
            ),
        ).toEqual([{ count: 0 }]);
    } finally {
        await f.close();
    }
});

it("does not expose a private SQL parameter or driver cause when storage fails", async () => {
    const f = await database();
    try {
        await agentDatabaseRun(f.ctx.db, sql`DROP TABLE happy_agent_config_native_accounts`);
        let failure: unknown;
        try {
            await nativeAccountIdentity(f.ctx, "private-native-principal");
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            "The private account identity could not be resolved.",
        );
        expect((failure as Error).cause).toBeUndefined();
        expect(String(failure)).not.toContain("private-native-principal");
        expect(JSON.stringify(failure)).not.toContain("private-native-principal");
    } finally {
        await f.close();
    }
});

async function database() {
    const root = await mkdtemp(join(tmpdir(), "native-identities-"));
    const filename = join(root, "agent.sqlite");
    let owner = await openAgentSQLiteDatabase(filename);
    let ctx = withAgentDatabase(createRootContext(), owner.database);
    for (const [, migrate] of nativeAccountIdentityMigrations) await migrate(ctx, owner.database);
    return {
        get ctx() {
            return ctx;
        },
        reopen: async () => {
            await owner.close();
            owner = await openAgentSQLiteDatabase(filename);
            ctx = withAgentDatabase(createRootContext(), owner.database);
        },
        close: async () => {
            await owner.close();
            await rm(root, { recursive: true, force: true });
        },
    };
}
