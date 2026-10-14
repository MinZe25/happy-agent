import { createAgentGym, frameEvent, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

async function startGym(): Promise<AgentGym> {
    const gym = await createAgentGym();
    running.push(gym);
    return gym;
}

const UNSET = { value: null, updatedAt: null, version: null };

interface SettingEvent {
    readonly setting: { readonly key: string; readonly value: unknown; readonly version: string };
    readonly mutationId?: string;
}

/** Every user settings event after `cursor`, oldest first. */
async function settingEvents(gym: AgentGym, cursor: string): Promise<SettingEvent[]> {
    const payloads: SettingEvent[] = [];
    for (let after = cursor; ; ) {
        const page = await gym.client.getEvents({ after, limit: 1_000 });
        for (const event of page.events) {
            if (event.type === "user_settings.updated") payloads.push(event.payload);
        }
        if (page.cursor === page.latestCursor) return payloads;
        after = page.cursor;
    }
}

describe("per-person settings through the public Happy Agent API", () => {
    it("syncs last-write-wins changes, clears, versions, events, bootstrap, and restart", async () => {
        const gym = await startGym();
        const initial = await gym.client.getUserSettings();
        expect(initial).toEqual({ settings: [], cursor: expect.any(String) });
        expect((await gym.client.getDesktopBootstrap()).userSettings).toEqual([]);
        expect(await gym.client.getUserSetting("happy-desktop.completionSound")).toEqual({
            setting: { key: "happy-desktop.completionSound", ...UNSET },
        });

        const stream = gym.stream("/v0/events/stream", { after: initial.cursor });
        try {
            await stream.opened();
            const at = Date.now() - 60_000;
            const saved = await gym.client.saveUserSetting("happy-desktop.completionSound", {
                mutationId: "first-write",
                value: { sound: "focused", volume: [1, 2] },
                updatedAt: at,
            });
            expect(saved.setting).toEqual({
                key: "happy-desktop.completionSound",
                value: { sound: "focused", volume: [1, 2] },
                updatedAt: at,
                version: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/),
            });
            const live = await stream.waitFor(
                (frame) => frameEvent(frame)?.type === "user_settings.updated",
                "the first settings event",
            );
            expect(frameEvent(live)?.payload).toEqual({
                setting: saved.setting,
                mutationId: "first-write",
            });
        } finally {
            stream.close();
        }

        // A stale device is answered with the stored entry and changes nothing.
        const key = "happy-desktop.completionSound";
        const stored = (await gym.client.getUserSetting(key)).setting;
        expect(stored).toMatchObject({ value: { sound: "focused", volume: [1, 2] } });
        const beforeStale = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        expect(
            await gym.client.saveUserSetting(key, {
                value: "older",
                updatedAt: stored.updatedAt! - 1,
            }),
        ).toEqual({ setting: stored });
        expect(await settingEvents(gym, beforeStale)).toEqual([]);

        // Repeating the stored value still applies under a newer version.
        const repeat = await gym.client.saveUserSetting(key, {
            value: { sound: "focused", volume: [1, 2] },
            updatedAt: stored.updatedAt!,
        });
        expect(repeat.setting.version! > stored.version!).toBe(true);

        // A clock running ahead counts as the daemon's own time.
        const ahead = await gym.client.saveUserSetting(key, {
            value: "ahead",
            updatedAt: Date.now() + 3_600_000,
        });
        expect(ahead.setting.updatedAt!).toBeLessThanOrEqual(Date.now());
        const later = await gym.client.saveUserSetting(key, {
            value: "later",
            updatedAt: Date.now(),
        });
        expect(later.setting.value).toBe("later");

        // A clear is kept and synced, and an older write cannot bring the value back.
        const cleared = await gym.client.saveUserSetting(key, {
            mutationId: "clear",
            value: null,
            updatedAt: later.setting.updatedAt!,
        });
        expect(cleared.setting).toMatchObject({ key, value: null });
        expect(cleared.setting.version! > later.setting.version!).toBe(true);
        expect(
            await gym.client.saveUserSetting(key, {
                value: "restored",
                updatedAt: cleared.setting.updatedAt! - 1,
            }),
        ).toEqual(cleared);
        const muted = await gym.client.saveUserSetting("happy-desktop.mutedBots", {
            value: ["bot-a"],
        });
        const empty = await gym.client.saveUserSetting("happy-desktop.hiddenBots", { value: null });
        expect(empty.setting).toMatchObject({ value: null, version: expect.any(String) });

        const listed = await gym.client.getUserSettings();
        expect(listed.settings).toEqual([cleared.setting, empty.setting, muted.setting]);
        expect((await gym.client.getDesktopBootstrap()).userSettings).toEqual(listed.settings);
        const events = await settingEvents(gym, initial.cursor);
        expect(events).toEqual([
            { setting: stored, mutationId: "first-write" },
            { setting: repeat.setting },
            { setting: ahead.setting },
            { setting: later.setting },
            { setting: cleared.setting, mutationId: "clear" },
            { setting: muted.setting },
            { setting: empty.setting },
        ]);
        const versions = events.map((event) => event.setting.version);
        expect([...versions].sort()).toEqual(versions);

        await gym.restart();
        expect((await gym.client.getUserSettings()).settings).toEqual(listed.settings);
        expect(
            await gym.client.saveUserSetting(key, {
                value: "restored",
                updatedAt: cleared.setting.updatedAt! - 1,
            }),
        ).toEqual(cleared);
        const afterRestart = await gym.client.saveUserSetting(key, { value: "after restart" });
        expect(afterRestart.setting.version! > empty.setting.version!).toBe(true);
        expect(gym.errors).toEqual([]);
    });

    it("keeps the newest of concurrent writes to one key from two devices", async () => {
        const gym = await startGym();
        const key = "happy-desktop.completionSound";
        const at = Date.now() - 10_000;
        await Promise.all(
            Array.from({ length: 16 }, (_, index) =>
                gym.client.saveUserSetting(key, {
                    value: index === 0 ? "newest" : `older ${String(index)}`,
                    updatedAt: at - index,
                }),
            ),
        );
        expect((await gym.client.getUserSetting(key)).setting).toMatchObject({
            value: "newest",
            updatedAt: at,
        });
        await gym.restart();
        expect((await gym.client.getUserSetting(key)).setting.value).toBe("newest");
        expect(gym.errors).toEqual([]);
    });

    it("forgets only the oldest clears and still ignores writes older than them", async () => {
        const gym = await startGym();
        const base = Date.now() - 1_000_000;
        for (let index = 1; index <= 1_001; index += 1) {
            await gym.client.saveUserSetting(`app.clear-${String(index).padStart(4, "0")}`, {
                value: null,
                updatedAt: base + index,
            });
        }
        const { settings, cursor } = await gym.client.getUserSettings();
        expect(settings).toHaveLength(1_000);
        expect(settings[0]?.key).toBe("app.clear-0002");

        // The forgotten clear's time is the horizon for every key holding nothing.
        expect(
            await gym.client.saveUserSetting("app.clear-0001", {
                value: "restored",
                updatedAt: base,
            }),
        ).toEqual({ setting: { key: "app.clear-0001", ...UNSET } });
        expect(
            await gym.client.saveUserSetting("app.fresh", { value: "stale", updatedAt: base }),
        ).toEqual({ setting: { key: "app.fresh", ...UNSET } });
        expect(await settingEvents(gym, cursor)).toEqual([]);
        expect(
            (await gym.client.saveUserSetting("app.fresh", { value: "new", updatedAt: base + 1 }))
                .setting.value,
        ).toBe("new");

        await gym.restart();
        expect(
            await gym.client.saveUserSetting("app.clear-0001", {
                value: "restored",
                updatedAt: base,
            }),
        ).toEqual({ setting: { key: "app.clear-0001", ...UNSET } });
        expect(gym.errors).toEqual([]);
    });

    it("refuses malformed keys and bodies, deep and large values, and full settings", async () => {
        const gym = await startGym();
        const { cursor } = await gym.client.getUserSettings();
        const refused = async (
            method: "GET" | "PUT",
            path: string,
            body: unknown,
            status: number,
            code: string,
        ) => {
            const response = await gym.raw.request(method, path, body);
            expect({ path, status: response.status, body: response.body }).toMatchObject({
                status,
                body: { code, error: expect.any(String) },
            });
            return response.body as { error: string };
        };

        for (const key of [
            "",
            ".hidden",
            "-dash",
            "a/b",
            "a%2Fb",
            "a%20b",
            "caf%C3%A9",
            "x".repeat(129),
        ]) {
            await refused("GET", `/v0/user-settings/${key}`, undefined, 400, "invalid_request");
            await refused("PUT", `/v0/user-settings/${key}`, { value: 1 }, 400, "invalid_request");
        }
        expect(
            (await gym.client.saveUserSetting("x".repeat(128), { value: 1 })).setting.key,
        ).toHaveLength(128);

        for (const body of [
            {},
            { value: 1, extra: true },
            { value: 1, updatedAt: -1 },
            { value: 1, updatedAt: 1.5 },
            { value: 1, mutationId: "" },
            { value: nested(33) },
        ]) {
            await refused("PUT", "/v0/user-settings/app.body", body, 400, "invalid_request");
        }
        expect(
            (await gym.client.saveUserSetting("app.body", { value: nested(32) })).setting.value,
        ).toEqual(nested(32));

        // A JSON string counts its characters and two quotes.
        const tooLarge = await refused(
            "PUT",
            "/v0/user-settings/app.big",
            { value: "x".repeat(65_535) },
            413,
            "too_large",
        );
        expect(tooLarge.error).toContain("64 KiB");
        await refused(
            "PUT",
            "/v0/user-settings/app.big",
            { value: "x".repeat(2_000_000) },
            413,
            "too_large",
        );
        await gym.client.saveUserSetting("app.big", { value: "x".repeat(65_534) });
        for (const key of ["app.big", "app.body", "x".repeat(128)]) {
            await gym.client.saveUserSetting(key, { value: null });
        }

        // Fifteen 64 KiB values under three-byte keys leave 65,491 bytes of 1 MiB.
        const full = "x".repeat(65_534);
        for (let index = 0; index < 15; index += 1) {
            await gym.client.saveUserSetting(`k${String(index).padStart(2, "0")}`, {
                value: full,
            });
        }
        const totalFull = await refused(
            "PUT",
            "/v0/user-settings/k15",
            { value: full },
            409,
            "settings_full",
        );
        expect(totalFull.error).toContain("1 MiB");
        expect((await gym.client.getUserSetting("k15")).setting).toEqual({ key: "k15", ...UNSET });
        const small = await gym.client.saveUserSetting("k15", { value: "s" });
        // A stale growth is answered with the stored entry; the same growth applied is refused.
        expect(
            await gym.client.saveUserSetting("k15", {
                value: full,
                updatedAt: small.setting.updatedAt! - 1,
            }),
        ).toEqual(small);
        await refused("PUT", "/v0/user-settings/k15", { value: full }, 409, "settings_full");
        // Neither a rewrite of the same size nor a clear is ever refused.
        await gym.client.saveUserSetting("k01", { value: "y".repeat(65_534) });
        await gym.client.saveUserSetting("k02", { value: null });
        expect((await gym.client.saveUserSetting("k15", { value: full })).setting.value).toBe(full);
        for (let index = 0; index < 16; index += 1) {
            await gym.client.saveUserSetting(`k${String(index).padStart(2, "0")}`, {
                value: null,
            });
        }

        // Every key above is cleared, so these thousand are the only ones holding values.
        for (let index = 0; index < 1_000; index += 1) {
            await gym.client.saveUserSetting(`n${String(index)}`, { value: index });
        }
        const countFull = await refused(
            "PUT",
            "/v0/user-settings/n1000",
            { value: 1 },
            409,
            "settings_full",
        );
        expect(countFull.error).toContain("1,000");
        await gym.client.saveUserSetting("n1000", { value: null });
        await gym.client.saveUserSetting("n0", { value: "rewritten" });
        await gym.client.saveUserSetting("n1", { value: null });
        expect((await gym.client.saveUserSetting("n1000", { value: 1 })).setting.value).toBe(1);

        // Refused and stale writes changed nothing and emitted nothing.
        const events = await settingEvents(gym, cursor);
        const changes = (key: string) =>
            events
                .filter((event) => event.setting.key === key)
                .map((event) => (event.setting.value === null ? "clear" : "value"));
        expect(changes("app.big")).toEqual(["value", "clear"]);
        expect(changes("app.body")).toEqual(["value", "clear"]);
        expect(changes("k01")).toEqual(["value", "value", "clear"]);
        expect(changes("k15")).toEqual(["value", "value", "clear"]);
        expect(changes("n1000")).toEqual(["clear", "value"]);
        expect(gym.errors).toEqual([]);
    });
});

type SettingValue = Parameters<AgentGym["client"]["saveUserSetting"]>[1]["value"];

function nested(depth: number): SettingValue {
    let value: SettingValue = 0;
    for (let level = 0; level < depth; level += 1) value = level % 2 === 0 ? [value] : { v: value };
    return value;
}
