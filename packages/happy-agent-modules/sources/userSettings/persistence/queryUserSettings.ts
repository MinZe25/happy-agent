import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { StoredUserSetting } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { UserSettingsOwner } from "../UserSettings.js";
import { USER_SETTINGS_TABLE } from "../UserSettingsMigrations.js";
import { userSettingFromRow } from "./userSettingRow.js";

/** Every key held for one person, values and retained clears, in ascending key order. */
export async function queryUserSettings(
    ctx: Context,
    owner: UserSettingsOwner,
): Promise<readonly StoredUserSetting[]> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT setting_key, value_json, updated_at, version
            FROM ${sql.raw(USER_SETTINGS_TABLE)}
            WHERE owner_id = ${owner}
            ORDER BY setting_key`,
    );
    return rows.map(userSettingFromRow);
}
