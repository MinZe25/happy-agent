import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import {
    MAX_USER_SETTING_KEYS,
    MAX_USER_SETTING_RETAINED_CLEARS,
    MAX_USER_SETTING_TOTAL_BYTES,
    type StoredUserSetting,
    type UserSetting,
    type UserSettingKey,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { createUserSettingVersion } from "../impl/createUserSettingVersion.js";
import type { UserSettingsOwner, UserSettingWrite } from "../UserSettings.js";
import { UserSettingsError } from "../UserSettingsError.js";
import { USER_SETTINGS_OWNERS_TABLE, USER_SETTINGS_TABLE } from "../UserSettingsMigrations.js";
import { queryUserSetting } from "./queryUserSetting.js";

/** What a write left: the entry it stored, or the stored entry unchanged when it was stale. */
export type UserSettingSave =
    | { readonly applied: true; readonly setting: StoredUserSetting }
    | { readonly applied: false; readonly setting: UserSetting };

const ownerStateSchema = Type.Object({
    last_version: Type.String(),
    horizon: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
const totalsSchema = Type.Object({
    keys: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    current: Type.Integer({ minimum: 0 }),
});
const clearCountSchema = Type.Object({ clears: Type.Integer({ minimum: 0 }) });
const clearSchema = Type.Object({
    setting_key: Type.String(),
    updated_at: Type.Integer({ minimum: 0 }),
});

/**
 * Apply one person's write to one key, last-write-wins by `updatedAt`, as one transaction.
 *
 * A supplied time ahead of `now` counts as `now`. A write older than the stored entry, or, for a
 * key holding nothing, older than the forgotten-clear horizon, changes nothing. An applied write
 * that would add a key past the limit or grow the total past it is refused. Otherwise the entry is
 * stored under a newly minted version; a clear is retained, and the oldest clears beyond the limit
 * are forgotten into the horizon.
 */
export async function saveUserSetting(
    ctx: Context,
    owner: UserSettingsOwner,
    key: UserSettingKey,
    write: UserSettingWrite,
    now: number,
): Promise<UserSettingSave> {
    return await ctx.inTx(async (txCtx) => {
        const stored = await queryUserSetting(txCtx, owner, key);
        const state = await queryOwnerState(txCtx, owner);
        const updatedAt = write.updatedAt === undefined ? now : Math.min(write.updatedAt, now);
        if (write.updatedAt !== undefined) {
            const floor = stored === undefined ? (state?.horizon ?? null) : stored.updatedAt;
            if (floor !== null && updatedAt < floor) {
                return {
                    applied: false,
                    setting: stored ?? { key, value: null, updatedAt: null, version: null },
                };
            }
        }

        const valueJson = write.value === null ? null : JSON.stringify(write.value);
        const bytes =
            valueJson === null ? 0 : Buffer.byteLength(key) + Buffer.byteLength(valueJson);
        const totals = await queryOwnerTotals(txCtx, owner, key);
        const holdsValue = stored !== undefined && stored.value !== null;
        const keys = totals.keys - (holdsValue ? 1 : 0) + (valueJson === null ? 0 : 1);
        if (keys > totals.keys && keys > MAX_USER_SETTING_KEYS) {
            throw new UserSettingsError(
                "settings_full",
                `Your settings already hold ${MAX_USER_SETTING_KEYS.toLocaleString("en-US")} keys. Clear one before adding another.`,
            );
        }
        const total = totals.total - totals.current + bytes;
        if (total > totals.total && total > MAX_USER_SETTING_TOTAL_BYTES) {
            throw new UserSettingsError(
                "settings_full",
                "Your settings would grow past 1 MiB. Clear or shrink some before adding more.",
            );
        }

        const version = createUserSettingVersion(state?.last_version, now);
        await agentDatabaseRun(
            txCtx.db,
            sql`INSERT INTO ${sql.raw(USER_SETTINGS_TABLE)}
                (owner_id, setting_key, value_json, bytes, updated_at, version)
                VALUES (${owner}, ${key}, ${valueJson}, ${bytes}, ${updatedAt}, ${version})
                ON CONFLICT (owner_id, setting_key) DO UPDATE SET
                    value_json = excluded.value_json,
                    bytes = excluded.bytes,
                    updated_at = excluded.updated_at,
                    version = excluded.version`,
        );
        await agentDatabaseRun(
            txCtx.db,
            sql`INSERT INTO ${sql.raw(USER_SETTINGS_OWNERS_TABLE)} (owner_id, last_version, horizon)
                VALUES (${owner}, ${version}, NULL)
                ON CONFLICT (owner_id) DO UPDATE SET last_version = excluded.last_version`,
        );
        if (valueJson === null) await forgetOldClears(txCtx, owner, key, state?.horizon ?? null);
        return { applied: true, setting: { key, value: write.value, updatedAt, version } };
    });
}

async function queryOwnerState(
    ctx: Context,
    owner: UserSettingsOwner,
): Promise<{ readonly last_version: string; readonly horizon: number | null } | undefined> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT last_version, horizon FROM ${sql.raw(USER_SETTINGS_OWNERS_TABLE)}
            WHERE owner_id = ${owner}`,
    );
    if (rows[0] === undefined) return undefined;
    if (!Value.Check(ownerStateSchema, rows[0])) {
        throw new Error("The stored user settings state is invalid.");
    }
    return rows[0];
}

/** Keys holding a value and their total bytes, with what `key` itself counts now. */
async function queryOwnerTotals(
    ctx: Context,
    owner: UserSettingsOwner,
    key: UserSettingKey,
): Promise<{ readonly keys: number; readonly total: number; readonly current: number }> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT COUNT(value_json) AS keys,
                COALESCE(SUM(bytes), 0) AS total,
                COALESCE(SUM(CASE WHEN setting_key = ${key} THEN bytes ELSE 0 END), 0) AS current
            FROM ${sql.raw(USER_SETTINGS_TABLE)}
            WHERE owner_id = ${owner}`,
    );
    if (!Value.Check(totalsSchema, rows[0])) {
        throw new Error("The stored user settings totals are invalid.");
    }
    return rows[0];
}

/**
 * Keep the most recent clears. The just-written clear is never the one forgotten, so the entry the
 * write reports is the one the person can read back.
 */
async function forgetOldClears(
    ctx: Context,
    owner: UserSettingsOwner,
    written: UserSettingKey,
    horizon: number | null,
): Promise<void> {
    const counted = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT COUNT(*) AS clears FROM ${sql.raw(USER_SETTINGS_TABLE)}
            WHERE owner_id = ${owner} AND value_json IS NULL`,
    );
    if (!Value.Check(clearCountSchema, counted[0])) {
        throw new Error("The stored user settings totals are invalid.");
    }
    const excess = counted[0].clears - MAX_USER_SETTING_RETAINED_CLEARS;
    if (excess <= 0) return;
    const forgotten = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT setting_key, updated_at FROM ${sql.raw(USER_SETTINGS_TABLE)}
            WHERE owner_id = ${owner} AND value_json IS NULL AND setting_key <> ${written}
            ORDER BY updated_at, version
            LIMIT ${excess}`,
    );
    let forgottenThrough = horizon ?? 0;
    for (const row of forgotten) {
        if (!Value.Check(clearSchema, row)) throw new Error("A stored user setting is invalid.");
        forgottenThrough = Math.max(forgottenThrough, row.updated_at);
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(USER_SETTINGS_TABLE)}
                WHERE owner_id = ${owner} AND setting_key = ${row.setting_key}`,
        );
    }
    await agentDatabaseRun(
        ctx.db,
        sql`UPDATE ${sql.raw(USER_SETTINGS_OWNERS_TABLE)} SET horizon = ${forgottenThrough}
            WHERE owner_id = ${owner}`,
    );
}
