import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ARTIFACT_DATA_LIMITS,
    ArtifactDataCursorUnavailableError,
    ArtifactDataTooLargeError,
} from "../../sources/artifactData/index.js";
import { ArtifactDataStore } from "../../sources/artifactData/impl/ArtifactDataStore.js";
import { artifactDataVersionTime } from "../../sources/artifactData/impl/createArtifactDataVersion.js";

const DAY = 24 * 60 * 60 * 1000;
const USER = "userdana";
const opened: { store: ArtifactDataStore; folder: string }[] = [];

afterEach(async () => {
    for (const { store, folder } of opened.splice(0)) {
        store.close();
        await rm(folder, { force: true, recursive: true });
    }
});

async function open(): Promise<{ store: ArtifactDataStore; path: string }> {
    const folder = await mkdtemp(join(tmpdir(), "artifact-data-"));
    const path = join(folder, "kv.sqlite");
    const store = await ArtifactDataStore.open(path);
    opened.push({ store, folder });
    return { store, path };
}

const set = (key: string, value: unknown) =>
    ({ kind: "set", key, valueJson: JSON.stringify(value) }) as const;

describe("one artifact's data store", () => {
    it("keeps versions increasing when the clock moves backwards and after reopening", async () => {
        const { store, path } = await open();
        const first = await store.write(set("a", 1), USER, undefined, undefined, 2_000_000);
        const second = await store.write(set("b", 2), USER, undefined, undefined, 1_000_000);
        expect(second.entry.version > first.entry.version).toBe(true);
        expect(artifactDataVersionTime(second.entry.version)).toBe(2_000_000);
        store.close();
        opened.pop();
        const reopened = await ArtifactDataStore.open(path);
        opened.push({ store: reopened, folder: join(path, "..") });
        const third = await reopened.write(set("a", 3), USER, undefined, undefined, 1_500_000);
        expect(third.entry.version > second.entry.version).toBe(true);
        expect((await reopened.get("a")).entry).toMatchObject({ value: 3 });
    });

    it("forgets old tombstones and refuses cursors from before them", async () => {
        const { store } = await open();
        const start = Date.UTC(2026, 0, 1);
        const kept = await store.write(set("kept", true), USER, undefined, undefined, start);
        await store.write(set("gone", true), USER, undefined, undefined, start + 1);
        const deleted = await store.write(
            { kind: "delete", key: "gone" },
            USER,
            undefined,
            undefined,
            start + 2,
        );
        expect((await store.changes(kept.entry.version, "", 10)).changes).toEqual([deleted.entry]);

        // The next write past the retention window prunes the tombstone and raises the horizon.
        const later = start + ARTIFACT_DATA_LIMITS.tombstoneRetentionMs + DAY;
        const fresh = await store.write(set("fresh", 1), USER, undefined, undefined, later);
        await expect(store.changes(kept.entry.version, "", 10)).rejects.toBeInstanceOf(
            ArtifactDataCursorUnavailableError,
        );
        expect((await store.changes(deleted.entry.version, "", 10)).changes).toEqual([fresh.entry]);
        expect((await store.list("", undefined, 10)).entries.map((entry) => entry.key)).toEqual([
            "fresh",
            "kept",
        ]);
    });

    it("answers a write ID once per day and forgets it afterwards", async () => {
        const { store } = await open();
        const now = Date.UTC(2026, 0, 1);
        const first = await store.write(set("n", 1), USER, "w1", undefined, now);
        const again = await store.write(set("n", 1), USER, "w1", undefined, now + 1000);
        expect(again).toMatchObject({ replayed: true, changed: false, entry: first.entry });
        // Another user's write ID is their own.
        const other = await store.write(set("n", 2), "userevan", "w1", undefined, now + 2000);
        expect(other.replayed).toBe(false);
        await store.write(set("x", 0), USER, undefined, undefined, now + DAY + 1);
        const expired = await store.write(set("n", 3), USER, "w1", undefined, now + DAY + 2);
        expect(expired).toMatchObject({ replayed: false, entry: { value: 3 } });
    });

    it("lists by prefix in key order and pages changes in version order", async () => {
        const { store } = await open();
        for (const key of ["b/2", "a/1", "b/1", "c"]) {
            await store.write(set(key, key), USER, undefined, undefined, Date.now());
        }
        const page = await store.list("b/", undefined, 1);
        expect(page.entries.map((entry) => entry.key)).toEqual(["b/1"]);
        expect(page.nextAfter).toBe("b/1");
        expect((await store.list("b/", "b/1", 5)).entries.map((entry) => entry.key)).toEqual([
            "b/2",
        ]);
        const first = await store.changes(undefined, "", 2);
        expect(first.changes.map((entry) => entry.key)).toEqual(["b/2", "a/1"]);
        expect(first.hasMore).toBe(true);
        const rest = await store.changes(first.cursor ?? undefined, "", 5);
        expect(rest).toMatchObject({ hasMore: false });
        expect(rest.changes.map((entry) => entry.key)).toEqual(["b/1", "c"]);
        expect((await store.changes(undefined, "b/", 5)).changes).toHaveLength(2);
    });

    it("refuses new keys once the store is full but still lets values shrink", async () => {
        const { store } = await open();
        const big = "x".repeat(200 * 1024);
        const count = Math.floor(ARTIFACT_DATA_LIMITS.storeBytes / (200 * 1024));
        for (let index = 0; index < count; index += 1) {
            await store.write(
                set(`k${String(index)}`, big),
                USER,
                undefined,
                undefined,
                Date.now(),
            );
        }
        await expect(
            store.write(set("overflow", big), USER, undefined, undefined, Date.now()),
        ).rejects.toBeInstanceOf(ArtifactDataTooLargeError);
        await store.write(set("k0", "small"), USER, undefined, undefined, Date.now());
        await store.write({ kind: "delete", key: "k1" }, USER, undefined, undefined, Date.now());
        await store.write(set("overflow", big), USER, undefined, undefined, Date.now());
    });
});
