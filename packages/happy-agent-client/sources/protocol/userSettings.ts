/**
 * User settings: one person's opaque key-value preferences, kept on the daemon so they follow that
 * person from device to device. The daemon checks only the shape and size of keys and values.
 */

import { type Static, Type } from "@sinclair/typebox";

import { eventCursorSchema, mutationIdSchema, resourceVersionSchema } from "./common.js";

export const MAX_USER_SETTING_KEY_LENGTH = 128;
/** A value's limit as compact UTF-8 JSON. */
export const MAX_USER_SETTING_VALUE_BYTES = 65_536;
/** How deeply a value's arrays and objects may nest. */
export const MAX_USER_SETTING_VALUE_DEPTH = 32;
/** Keys holding a value, per person. */
export const MAX_USER_SETTING_KEYS = 1_000;
/** Keys and their compact JSON values together, per person, counted in UTF-8. */
export const MAX_USER_SETTING_TOTAL_BYTES = 1_048_576;
/** The most recent clears the daemon keeps per person; older ones become a stale-write horizon. */
export const MAX_USER_SETTING_RETAINED_CLEARS = 1_000;

/** Letters, digits, `.`, `_`, and `-`, starting with a letter or digit; never percent-encoded. */
export const userSettingKeySchema = Type.String({
    maxLength: MAX_USER_SETTING_KEY_LENGTH,
    minLength: 1,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});
export type UserSettingKey = Static<typeof userSettingKeySchema>;

/** Any JSON value; `null` means the key holds no value. */
export const userSettingValueSchema = Type.Recursive((value) =>
    Type.Union([
        Type.String(),
        Type.Number(),
        Type.Boolean(),
        Type.Null(),
        Type.Array(value),
        Type.Record(Type.String(), value),
    ]),
);
export type UserSettingValue = Static<typeof userSettingValueSchema>;

/** Epoch milliseconds a write may carry for last-write-wins. */
const userSettingTimestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

/** A key the daemon holds an entry for: a value, or a retained clear with `value: null`. */
export const storedUserSettingSchema = Type.Object({
    key: userSettingKeySchema,
    value: userSettingValueSchema,
    /** The last applied change's time, which last-write-wins compares. */
    updatedAt: userSettingTimestampSchema,
    /** Minted when that change applied; greater than every earlier version of this person's. */
    version: resourceVersionSchema,
});
export type StoredUserSetting = Static<typeof storedUserSettingSchema>;

/** A key the daemon holds nothing for: never written, or its clear was forgotten. */
export const unsetUserSettingSchema = Type.Object({
    key: userSettingKeySchema,
    value: Type.Null(),
    updatedAt: Type.Null(),
    version: Type.Null(),
});
export type UnsetUserSetting = Static<typeof unsetUserSettingSchema>;

/** The setting object. */
export const userSettingSchema = Type.Union([storedUserSettingSchema, unsetUserSettingSchema]);
export type UserSetting = Static<typeof userSettingSchema>;

/** `GET /v0/user-settings` — every held key in ascending key order, clears included. */
export const userSettingsResponseSchema = Type.Object({
    /** Captured before the settings were read; follow events after it. */
    cursor: eventCursorSchema,
    settings: Type.Array(storedUserSettingSchema),
});
export type UserSettingsResponse = Static<typeof userSettingsResponseSchema>;

/** `GET` and `PUT /v0/user-settings/:key` — the authoritative entry. */
export const userSettingResponseSchema = Type.Object({ setting: userSettingSchema });
export type UserSettingResponse = Static<typeof userSettingResponseSchema>;

/** `PUT /v0/user-settings/:key` */
export const saveUserSettingRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    /** The JSON value to store, or `null` to clear the key. */
    value: userSettingValueSchema,
    /**
     * When the person made this change. A write older than the stored entry is ignored; a time
     * ahead of the daemon's clock counts as its current time. Omitted, the write always applies.
     */
    updatedAt: Type.Optional(userSettingTimestampSchema),
});
export type SaveUserSettingRequest = Static<typeof saveUserSettingRequestSchema>;
