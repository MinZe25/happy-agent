import { cuid2Schema } from "@slopus/happy-agent-base";
import {
    MAX_USER_SETTING_VALUE_DEPTH,
    type StoredUserSetting,
    type UserSettingValue,
} from "@slopus/happy-agent-client";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/** The one person of a standalone installation, who has no team user ID. */
export const STANDALONE_USER_SETTINGS_OWNER = "standalone";

/** Whose settings: a team user's installation-local ID, or the standalone installation's person. */
export const userSettingsOwnerSchema = Type.Union([
    cuid2Schema,
    Type.Literal(STANDALONE_USER_SETTINGS_OWNER),
]);
export type UserSettingsOwner = Static<typeof userSettingsOwnerSchema>;

const jsonLeafSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

function jsonValueAtDepth(depth: number): TSchema {
    if (depth <= 0) return jsonLeafSchema;
    const child = jsonValueAtDepth(depth - 1);
    return Type.Union([jsonLeafSchema, Type.Array(child), Type.Record(Type.String(), child)]);
}

/**
 * A setting's JSON value, its arrays and objects nested at most the specified depth. The bound is
 * part of the schema so checking an untrusted value never recurses deeper than the limit.
 */
export const userSettingValueSchema = Type.Unsafe<UserSettingValue>(
    jsonValueAtDepth(MAX_USER_SETTING_VALUE_DEPTH),
);

/** One write: the value to store, or `null` to clear, and when the person made the change. */
export const userSettingWriteSchema = Type.Object(
    {
        value: userSettingValueSchema,
        updatedAt: Type.Optional(Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
    },
    { additionalProperties: false },
);
export type UserSettingWrite = Static<typeof userSettingWriteSchema>;

/** A write that applied, as committed; one person's change to one key. */
export interface UserSettingChangedEvent {
    readonly owner: UserSettingsOwner;
    readonly setting: StoredUserSetting;
}

export type UserSettingsListener = (
    ctx: Context,
    event: UserSettingChangedEvent,
) => void | Promise<void>;
