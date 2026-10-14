import type { UserSettingValue } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
    TeamAuthenticationError,
    TeamModule,
    withTeamUser,
    type TeamUser,
} from "../../sources/team/index.js";
import {
    UserSettingsError,
    UserSettingsModule,
    type UserSettingChangedEvent,
} from "../../sources/userSettings/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { testProfileModule } from "../support/testProfileModule.js";

const ALICE = "alice0000000000000000001";
const BOB = "bob00000000000000000000002";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

it("keeps each member's settings apart and standalone settings away from members", async () => {
    const settings = new UserSettingsModule(createTeam(true));
    const standalone = new UserSettingsModule(createTeam(false));
    const database = moduleDatabase(settings.migrations, "user-settings-owners");
    await database.ready;
    const alice = member(database.context, ALICE);
    const bob = member(database.context, BOB);
    try {
        await settings.save(alice, "app.sound", { value: "always", updatedAt: 10 });
        await settings.save(bob, "app.sound", { value: "never", updatedAt: 10 });
        await standalone.save(database.context, "app.sound", { value: "focused", updatedAt: 10 });

        expect((await settings.list(alice)).map((setting) => setting.value)).toEqual(["always"]);
        expect((await settings.get(bob, "app.sound")).value).toBe("never");
        expect((await standalone.list(database.context)).map((setting) => setting.value)).toEqual([
            "focused",
        ]);
        expect(
            await settings.get(member(database.context, "carol000000000000000003"), "app.sound"),
        ).toEqual({ key: "app.sound", value: null, updatedAt: null, version: null });

        await expect(settings.list(database.context)).rejects.toThrow(TeamAuthenticationError);
        await expect(
            settings.save(database.context, "app.sound", { value: "always" }),
        ).rejects.toThrow(TeamAuthenticationError);
    } finally {
        database.close();
    }
});

it("keeps the latest write by the person's time and answers a stale one with what is stored", async () => {
    const settings = new UserSettingsModule(createTeam(false));
    const database = moduleDatabase(settings.migrations, "user-settings-last-write-wins");
    await database.ready;
    const events: UserSettingChangedEvent[] = [];
    settings.onEvent((_ctx, event) => {
        events.push(event);
    });
    const ctx = database.context;
    try {
        const first = await settings.save(ctx, "app.mode", { value: { a: [1] }, updatedAt: 100 });
        expect(first).toMatchObject({ key: "app.mode", value: { a: [1] }, updatedAt: 100 });
        expect(first.version).toMatch(UUID_V7);

        expect(await settings.save(ctx, "app.mode", { value: "older", updatedAt: 99 })).toEqual(
            first,
        );
        expect(events).toHaveLength(1);

        // The same time is not older, and a repeat still applies under a new version.
        const repeat = await settings.save(ctx, "app.mode", { value: { a: [1] }, updatedAt: 100 });
        expect(repeat.version! > first.version!).toBe(true);
        expect(events).toHaveLength(2);

        // A device clock ahead of the daemon's counts as the daemon's own time.
        const ahead = await settings.save(ctx, "app.mode", {
            value: "ahead",
            updatedAt: 5_000_000,
        });
        expect(ahead.updatedAt).toBe(1_000_000);
        vi.setSystemTime(1_000_010);
        expect(
            (await settings.save(ctx, "app.mode", { value: "later", updatedAt: 1_000_005 })).value,
        ).toBe("later");

        // Omitted, the write applies at the daemon's time even over a newer stored entry.
        vi.setSystemTime(500);
        const omitted = await settings.save(ctx, "app.mode", { value: "now" });
        expect(omitted).toMatchObject({ value: "now", updatedAt: 500 });
        expect(events.map((event) => event.setting)).toEqual([
            first,
            repeat,
            ahead,
            expect.objectContaining({ value: "later" }),
            omitted,
        ]);
        expect(events.every((event) => event.owner === "standalone")).toBe(true);
    } finally {
        database.close();
    }
});

it("syncs a clear like a change so an older write cannot bring the value back", async () => {
    const settings = new UserSettingsModule(createTeam(false));
    const database = moduleDatabase(settings.migrations, "user-settings-clears");
    await database.ready;
    const ctx = database.context;
    try {
        await settings.save(ctx, "app.muted", { value: true, updatedAt: 10 });
        const cleared = await settings.save(ctx, "app.muted", { value: null, updatedAt: 20 });
        expect(cleared).toMatchObject({ key: "app.muted", value: null, updatedAt: 20 });
        expect(cleared.version).toMatch(UUID_V7);
        expect(await settings.list(ctx)).toEqual([cleared]);

        expect(await settings.save(ctx, "app.muted", { value: true, updatedAt: 15 })).toEqual(
            cleared,
        );
        expect(await settings.get(ctx, "app.muted")).toEqual(cleared);

        // Clearing a key that holds nothing applies and is retained like any clear.
        const empty = await settings.save(ctx, "app.never", { value: null, updatedAt: 5 });
        expect(empty).toMatchObject({ value: null, updatedAt: 5 });
        expect(empty.version! > cleared.version!).toBe(true);
        expect((await settings.list(ctx)).map((setting) => setting.key)).toEqual([
            "app.muted",
            "app.never",
        ]);
    } finally {
        database.close();
    }
});

it("forgets only the oldest clears beyond the limit and ignores writes older than them", async () => {
    const settings = new UserSettingsModule(createTeam(false));
    const database = moduleDatabase(settings.migrations, "user-settings-horizon");
    await database.ready;
    const ctx = database.context;
    try {
        await settings.save(ctx, "app.kept", { value: "value", updatedAt: 1 });
        for (let index = 1; index <= 1_001; index += 1) {
            await settings.save(ctx, `clear.${String(index).padStart(4, "0")}`, {
                value: null,
                updatedAt: 100 + index,
            });
        }
        const listed = await settings.list(ctx);
        expect(listed.filter((setting) => setting.value === null)).toHaveLength(1_000);
        expect(listed.some((setting) => setting.key === "clear.0001")).toBe(false);
        expect(listed.some((setting) => setting.key === "clear.0002")).toBe(true);
        expect(listed.some((setting) => setting.key === "app.kept")).toBe(true);

        // The forgotten clear was at 101: an older write to any key holding nothing is stale.
        expect(
            await settings.save(ctx, "clear.0001", { value: "restored", updatedAt: 100 }),
        ).toEqual({ key: "clear.0001", value: null, updatedAt: null, version: null });
        expect(await settings.save(ctx, "fresh.key", { value: "old", updatedAt: 50 })).toEqual({
            key: "fresh.key",
            value: null,
            updatedAt: null,
            version: null,
        });
        // A held key still compares with its own entry, and a later write applies anywhere.
        expect((await settings.save(ctx, "app.kept", { value: "next", updatedAt: 2 })).value).toBe(
            "next",
        );
        expect(
            (await settings.save(ctx, "clear.0001", { value: "new", updatedAt: 101 })).value,
        ).toBe("new");

        // The clear being written is never the one forgotten, even when it is the oldest.
        const oldest = await settings.save(ctx, "app.kept", { value: null, updatedAt: 3 });
        expect(await settings.get(ctx, "app.kept")).toEqual(oldest);
        expect((await settings.list(ctx)).filter((setting) => setting.value === null)).toHaveLength(
            1_000,
        );
        expect(await settings.get(ctx, "clear.0002")).toEqual({
            key: "clear.0002",
            value: null,
            updatedAt: null,
            version: null,
        });
    } finally {
        database.close();
    }
}, 60_000);

it("refuses malformed keys, deep or large values, and writes that would pass the limits", async () => {
    const settings = new UserSettingsModule(createTeam(false));
    const database = moduleDatabase(settings.migrations, "user-settings-limits");
    await database.ready;
    const ctx = database.context;
    const refusal = async (operation: Promise<unknown>): Promise<string> => {
        const error: unknown = await operation.then(
            () => undefined,
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(UserSettingsError);
        return (error as UserSettingsError).code;
    };
    try {
        for (const key of ["", ".hidden", "-dash", "a/b", "a%2Fb", "a b", "x".repeat(129)]) {
            expect(await refusal(settings.get(ctx, key))).toBe("invalid_request");
            expect(await refusal(settings.save(ctx, key, { value: 1 }))).toBe("invalid_request");
        }
        expect((await settings.save(ctx, "x".repeat(128), { value: 1 })).key).toHaveLength(128);
        await settings.save(ctx, "x".repeat(128), { value: null });

        expect(await refusal(settings.save(ctx, "app.deep", { value: nested(33) }))).toBe(
            "invalid_request",
        );
        expect(await refusal(settings.save(ctx, "app.deep", { value: nested(100_000) }))).toBe(
            "invalid_request",
        );
        expect((await settings.save(ctx, "app.deep", { value: nested(32) })).value).toEqual(
            nested(32),
        );
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
            expect(await refusal(settings.save(ctx, "app.bad", { value } as never))).toBe(
                "invalid_request",
            );
        }
        expect(await refusal(settings.save(ctx, "app.bad", { value: 1, updatedAt: -1 }))).toBe(
            "invalid_request",
        );

        // A JSON string is its characters and two quotes.
        expect(await refusal(settings.save(ctx, "app.big", { value: "x".repeat(65_535) }))).toBe(
            "too_large",
        );
        await settings.save(ctx, "app.big", { value: "x".repeat(65_534) });
        await settings.save(ctx, "app.big", { value: null });
        await settings.save(ctx, "app.deep", { value: null });

        // Fifteen 64 KiB values under three-byte keys fill all but 65,491 bytes of 1 MiB.
        const full = "x".repeat(65_534);
        for (let index = 0; index < 15; index += 1) {
            await settings.save(ctx, `k${String(index).padStart(2, "0")}`, {
                value: full,
                updatedAt: 1_000,
            });
        }
        expect(await refusal(settings.save(ctx, "k15", { value: full }))).toBe("settings_full");
        await expect(settings.save(ctx, "k15", { value: full })).rejects.toThrow("1 MiB");
        expect(await settings.get(ctx, "k15")).toMatchObject({ value: null, version: null });

        // 65,003 bytes fit, leaving 488; growing that key by 536 more does not.
        const fits = await settings.save(ctx, "k15", { value: "x".repeat(64_998) });
        expect(await refusal(settings.save(ctx, "k15", { value: full }))).toBe("settings_full");
        // A stale growth, a rewrite of the same size, and a clear are never refused.
        expect(await settings.save(ctx, "k15", { value: full, updatedAt: 999 })).toEqual(fits);
        await settings.save(ctx, "k00", { value: "y".repeat(65_534) });
        await settings.save(ctx, "k02", { value: null });
        expect((await settings.save(ctx, "k15", { value: full })).value).toBe(full);
        expect((await settings.save(ctx, "k01", { value: "small" })).value).toBe("small");
    } finally {
        database.close();
    }
});

it("refuses a key past a thousand values but never a rewrite or a clear", async () => {
    const settings = new UserSettingsModule(createTeam(false));
    const database = moduleDatabase(settings.migrations, "user-settings-count");
    await database.ready;
    const ctx = database.context;
    try {
        for (let index = 0; index < 1_000; index += 1) {
            await settings.save(ctx, `k${index}`, { value: index });
        }
        await expect(settings.save(ctx, "k1000", { value: 1 })).rejects.toMatchObject({
            code: "settings_full",
            message: expect.stringContaining("1,000"),
        });
        await settings.save(ctx, "k1000", { value: null });
        await settings.save(ctx, "k0", { value: "rewritten" });
        await settings.save(ctx, "k1", { value: null });
        await settings.save(ctx, "k1000", { value: 1 });
        expect((await settings.list(ctx)).filter((setting) => setting.value !== null)).toHaveLength(
            1_000,
        );
    } finally {
        database.close();
    }
}, 60_000);

it("mints ever-greater versions across keys, a clock moved back, and a new module", async () => {
    const team = createTeam(false);
    const database = moduleDatabase(
        new UserSettingsModule(team).migrations,
        "user-settings-versions",
    );
    await database.ready;
    const ctx = database.context;
    try {
        const versions: string[] = [];
        let settings = new UserSettingsModule(team);
        versions.push((await settings.save(ctx, "a", { value: 1 })).version!);
        versions.push((await settings.save(ctx, "b", { value: 1 })).version!);
        vi.setSystemTime(10);
        versions.push((await settings.save(ctx, "c", { value: 1 })).version!);
        settings = new UserSettingsModule(team);
        versions.push((await settings.save(ctx, "a", { value: null })).version!);
        expect(versions.every((version) => UUID_V7.test(version))).toBe(true);
        expect([...versions].sort()).toEqual(versions);
        expect(new Set(versions).size).toBe(versions.length);
    } finally {
        database.close();
    }
});

it("joins its caller's transaction and announces a write only after it commits", async () => {
    const settings = new UserSettingsModule(createTeam(false));
    const database = moduleDatabase(settings.migrations, "user-settings-transactions");
    await database.ready;
    const events: UserSettingChangedEvent[] = [];
    const unsubscribe = settings.onEvent((_ctx, event) => {
        events.push(event);
    });
    try {
        await expect(
            database.context.inTx(async (ctx) => {
                const written = await settings.save(ctx, "app.x", { value: 1, updatedAt: 10 });
                expect(await settings.get(ctx, "app.x")).toEqual(written);
                expect(events).toEqual([]);
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");
        expect(events).toEqual([]);
        expect(await settings.list(database.context)).toEqual([]);

        let committed: unknown;
        await database.context.inTx(async (ctx) => {
            committed = await settings.save(ctx, "app.x", { value: [{ deep: true }] });
            expect(events).toEqual([]);
        });
        expect(events).toEqual([{ owner: "standalone", setting: committed }]);
        expect(Object.isFrozen(events[0])).toBe(true);
        expect(Object.isFrozen(events[0]?.setting.value)).toBe(true);

        unsubscribe();
        await settings.save(database.context, "app.x", { value: 2 });
        expect(events).toHaveLength(1);
    } finally {
        database.close();
    }
});

function nested(depth: number): UserSettingValue {
    let value: UserSettingValue = 0;
    for (let level = 0; level < depth; level += 1) value = level % 2 === 0 ? [value] : { v: value };
    return value;
}

function member(ctx: Context, id: string): Context {
    return withTeamUser(ctx, {
        id,
        authentication: "workos",
        subject: `user_${id}`,
        firstName: "Test",
        lastName: null,
        email: `${id}@example.com`,
        isOwner: false,
        photo: null,
        createdAt: 0,
        updatedAt: 0,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    } as TeamUser);
}

function createTeam(enabled: boolean): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            authentication: "workos",
                            enabled,
                            host: "127.0.0.1",
                            ownerWorkOSUserId: "user_01TESTUSER123",
                            port: 3_000,
                            workosClientId: "client_test123",
                            workosOrganizationId: "org_01TESTORG123",
                        },
                    },
                },
            },
        } as never,
        testProfileModule(),
    );
}
