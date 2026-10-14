import { type StoredUserSetting, storedUserSettingSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { userSettingValueSchema } from "../UserSettings.js";

/** The columns every setting read selects, in the shape the database returns them. */
export const userSettingRowSchema = Type.Object({
    setting_key: Type.String(),
    value_json: Type.Union([Type.String(), Type.Null()]),
    updated_at: Type.Integer({ minimum: 0 }),
    version: Type.String(),
});

/** A stored row as its setting object; a row that does not parse is a corrupt database. */
export function userSettingFromRow(row: unknown): StoredUserSetting {
    if (!Value.Check(userSettingRowSchema, row)) {
        throw new Error("A stored user setting is invalid.");
    }
    const value: unknown = row.value_json === null ? null : JSON.parse(row.value_json);
    const setting = {
        key: row.setting_key,
        value,
        updatedAt: row.updated_at,
        version: row.version,
    };
    if (
        !Value.Check(userSettingValueSchema, value) ||
        !Value.Check(storedUserSettingSchema, setting)
    ) {
        throw new Error("A stored user setting is invalid.");
    }
    return setting;
}
