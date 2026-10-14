import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentApiError,
    HappyAgentClient,
    desktopBootstrapResponseSchema,
    saveUserSettingRequestSchema,
    userSettingKeySchema,
    userSettingResponseSchema,
    userSettingSchema,
    userSettingsResponseSchema,
    userSettingsUpdatedPayloadSchema,
    type HappyAgentEvent,
    type StoredUserSetting,
    type UnsetUserSetting,
} from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const cursor = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const updatedAt = 1_755_400_000_000;

const sound: StoredUserSetting = {
    key: "happy-desktop.completionSound",
    value: "focused",
    updatedAt,
    version,
};
const clearedBot: StoredUserSetting = {
    key: "happy-desktop.bot.pfh0haxfpzowht3oi213cqos",
    value: null,
    updatedAt: updatedAt - 1,
    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5d",
};
const unset: UnsetUserSetting = {
    key: "happy-desktop.never",
    value: null,
    updatedAt: null,
    version: null,
};

function recordingClient(body: unknown, status = 200) {
    const requests: { method: string; url: string; body: string | null }[] = [];
    const client = new HappyAgentClient({
        endpoint: "http://agent.local",
        token: "t",
        fetch: async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            return Response.json(body, { status });
        },
    });
    return { client, requests };
}

describe("user settings protocol", () => {
    it("accepts namespaced keys that never need percent-encoding", () => {
        for (const key of [sound.key, clearedBot.key, "A", "9.lives", "a..b", "x".repeat(128)]) {
            expect(Value.Check(userSettingKeySchema, key)).toBe(true);
        }
        for (const key of [
            "",
            ".",
            "..",
            ".hidden",
            "-dash",
            "_under",
            "a/b",
            "a b",
            "a:b",
            "a%2Fb",
            "café",
            "x".repeat(129),
        ]) {
            expect(Value.Check(userSettingKeySchema, key)).toBe(false);
        }
    });

    it("distinguishes held values, retained clears, and keys the daemon holds nothing for", () => {
        const nested: StoredUserSetting = {
            ...sound,
            value: { muted: true, hidden: false, sounds: ["always", 2, null] },
        };
        for (const setting of [sound, nested, clearedBot, unset]) {
            expect(Value.Check(userSettingSchema, setting)).toBe(true);
            expect(Value.Check(userSettingResponseSchema, { setting })).toBe(true);
        }
        // A held entry always carries the time and version of its last applied change.
        expect(Value.Check(userSettingSchema, { ...sound, version: null })).toBe(false);
        expect(Value.Check(userSettingSchema, { ...sound, updatedAt: null })).toBe(false);
        // A key the daemon holds nothing for cannot carry a value or a version.
        expect(Value.Check(userSettingSchema, { ...unset, value: "x" })).toBe(false);
        expect(Value.Check(userSettingSchema, { ...unset, version })).toBe(false);
        expect(Value.Check(userSettingSchema, { ...sound, key: "a/b" })).toBe(false);
        expect(Value.Check(userSettingSchema, { ...sound, value: undefined })).toBe(false);
        expect(Value.Check(userSettingSchema, { ...sound, value: Number.NaN })).toBe(false);
    });

    it("lists only held entries with the cursor that closes the snapshot window", () => {
        expect(
            Value.Check(userSettingsResponseSchema, { settings: [clearedBot, sound], cursor }),
        ).toBe(true);
        expect(Value.Check(userSettingsResponseSchema, { settings: [], cursor })).toBe(true);
        expect(Value.Check(userSettingsResponseSchema, { settings: [unset], cursor })).toBe(false);
        expect(Value.Check(userSettingsResponseSchema, { settings: [sound] })).toBe(false);
    });

    it("requires a value, with null as the clear, and bounds the last-write-wins time", () => {
        expect(Value.Check(saveUserSettingRequestSchema, { value: "always" })).toBe(true);
        expect(Value.Check(saveUserSettingRequestSchema, { value: null, updatedAt })).toBe(true);
        expect(
            Value.Check(saveUserSettingRequestSchema, {
                mutationId: "mute-1",
                value: { muted: true },
                updatedAt: 0,
            }),
        ).toBe(true);
        expect(Value.Check(saveUserSettingRequestSchema, {})).toBe(false);
        expect(Value.Check(saveUserSettingRequestSchema, { value: 1, updatedAt: -1 })).toBe(false);
        expect(Value.Check(saveUserSettingRequestSchema, { value: 1, updatedAt: 1.5 })).toBe(false);
    });

    it("keeps user settings optional and additive in desktop bootstrap", () => {
        expect(desktopBootstrapResponseSchema.required ?? []).not.toContain("userSettings");
        const field = desktopBootstrapResponseSchema.properties.userSettings;
        expect(Value.Check(field, [clearedBot, sound])).toBe(true);
        expect(Value.Check(field, [])).toBe(true);
        expect(Value.Check(field, [unset])).toBe(false);
    });

    it("delivers each applied change as one complete entry with its mutation echo", () => {
        const events: HappyAgentEvent[] = [
            {
                cursor,
                occurredAt: updatedAt,
                payload: { setting: sound, mutationId: "sound-1" },
                type: "user_settings.updated",
            },
            {
                cursor,
                occurredAt: updatedAt,
                payload: { setting: clearedBot },
                type: "user_settings.updated",
            },
        ];
        for (const event of events) {
            expect(Value.Check(userSettingsUpdatedPayloadSchema, event.payload)).toBe(true);
        }
        // Only an applied write emits, so an event never describes a key holding nothing.
        expect(Value.Check(userSettingsUpdatedPayloadSchema, { setting: unset })).toBe(false);
        expect(Value.Check(userSettingsUpdatedPayloadSchema, { mutationId: "x" })).toBe(false);
    });

    it("reads, sets, and clears settings through their routes", async () => {
        const { client, requests } = recordingClient({ setting: sound });

        await expect(client.getUserSetting(sound.key)).resolves.toEqual({ setting: sound });
        await client.saveUserSetting(sound.key, {
            mutationId: "sound-1",
            value: "focused",
            updatedAt,
        });
        await client.saveUserSetting(clearedBot.key, { value: null });

        expect(requests).toEqual([
            {
                body: null,
                method: "GET",
                url: "http://agent.local/v0/user-settings/happy-desktop.completionSound",
            },
            {
                body: JSON.stringify({ mutationId: "sound-1", value: "focused", updatedAt }),
                method: "PUT",
                url: "http://agent.local/v0/user-settings/happy-desktop.completionSound",
            },
            {
                body: JSON.stringify({ value: null }),
                method: "PUT",
                url: `http://agent.local/v0/user-settings/${clearedBot.key}`,
            },
        ]);
    });

    it("lists settings through a remote connection under that daemon's authority", async () => {
        const body = { settings: [clearedBot, sound], cursor };
        const { client, requests } = recordingClient(body);

        await expect(client.connection("build-mac").getUserSettings()).resolves.toEqual(body);
        expect(requests).toEqual([
            {
                body: null,
                method: "GET",
                url: "http://agent.local/v0/connections/build-mac/api/v0/user-settings",
            },
        ]);
    });

    it("refuses an invalid key before sending anything", async () => {
        const { client, requests } = recordingClient({ setting: sound });

        for (const key of ["", "../profile", "a/b", "a%2Fb", ".."]) {
            await expect(client.getUserSetting(key)).rejects.toThrow(
                "The user setting key is invalid.",
            );
            await expect(client.saveUserSetting(key, { value: 1 })).rejects.toThrow(
                "The user setting key is invalid.",
            );
        }
        expect(requests).toEqual([]);
    });

    it("surfaces an older daemon's 404 so a client can keep settings on the device", async () => {
        const { client } = recordingClient({ error: "Not found.", code: "not_found" }, 404);

        const error = await client.getUserSettings().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({ code: "not_found", status: 404 });
    });
});
