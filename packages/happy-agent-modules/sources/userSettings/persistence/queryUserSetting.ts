import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { StoredUserSetting, UserSettingKey } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { UserSettingsOwner } from "../UserSettings.js";
import { USER_SETTINGS_TABLE } from "../UserSettingsMigrations.js";
import { userSettingFromRow } from "./userSettingRow.js";

/** One person's entry for one key, or `undefined` when nothing is held for it. */
export async function queryUserSetting(
    ctx: Context,
    owner: UserSettingsOwner,
    key: UserSettingKey,
): Promise<StoredUserSetting | undefined> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT setting_key, value_json, updated_at, version
            FROM ${sql.raw(USER_SETTINGS_TABLE)}
            WHERE owner_id = ${owner} AND setting_key = ${key}`,
    );
    return rows[0] === undefined ? undefined : userSettingFromRow(rows[0]);
}
