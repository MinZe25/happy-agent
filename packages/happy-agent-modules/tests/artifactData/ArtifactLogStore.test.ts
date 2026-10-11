import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ARTIFACT_LOG_LIMITS } from "../../sources/artifactData/index.js";
import { ArtifactDataStores } from "../../sources/artifactData/impl/ArtifactDataStores.js";
import {
    ArtifactLogStore,
    type ArtifactLogRecord,
} from "../../sources/artifactData/impl/ArtifactLogStore.js";

const DAY = 24 * 60 * 60 * 1000;
const folders: string[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    for (const folder of folders.splice(0)) await rm(folder, { force: true, recursive: true });
});

async function folder(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "artifact-logs-"));
    folders.push(path);
    return path;
}

function record(message: string, at: number, overrides: Partial<ArtifactLogRecord> = {}) {
    return {
        at,
        clientAt: null,
        level: "info",
        source: "app",
        message,
        dataJson: null,
        userId: "uana",
        version: 3,
        url: null,
        ...overrides,
    } satisfies ArtifactLogRecord;
}

describe("an artifact's debug log", () => {
    it("keeps only the newest entries and the last week, newest first", async () => {
        const store = await ArtifactLogStore.open(join(await folder(), "logs.sqlite"));
        closers.push(() => store.close());
        const now = 100 * DAY;
        await store.append([record("ancient", now - 8 * DAY)], now - 8 * DAY);
        const batch = Array.from({ length: ARTIFACT_LOG_LIMITS.keptEntries + 5 }, (_, index) =>
            record(`entry ${String(index)}`, now),
        );
        await store.append(batch, now);
        const page = await store.read({}, ARTIFACT_LOG_LIMITS.pageSize, now);
        expect(page.entries[0]?.message).toBe(`entry ${String(batch.length - 1)}`);
        let total = 0;
        let before: string | undefined;
        const messages: string[] = [];
        for (;;) {
            const next = await store.read(
                before === undefined ? {} : { before },
                ARTIFACT_LOG_LIMITS.pageSize,
                now,
            );
            total += next.entries.length;
            messages.push(...next.entries.map((entry) => entry.message));
            if (next.nextBefore === undefined) break;
            before = next.nextBefore;
        }
        expect(total).toBe(ARTIFACT_LOG_LIMITS.keptEntries);
        expect(messages).not.toContain("ancient");
        expect(messages).not.toContain("entry 4");
        expect(messages.at(-1)).toBe("entry 5");
    });

    it("filters by least severe level, person, and time", async () => {
        const store = await ArtifactLogStore.open(join(await folder(), "logs.sqlite"));
        closers.push(() => store.close());
        const now = 10 * DAY;
        await store.append(
            [
                record("info", now - 3_000),
                record("warn", now - 2_000, { level: "warn", userId: "ubob" }),
                record("error", now - 1_000, { level: "error", dataJson: '{"stack":"at x"}' }),
            ],
            now,
        );
        const messages = async (query: Parameters<ArtifactLogStore["read"]>[0]) =>
            (await store.read(query, 50, now)).entries.map((entry) => entry.message);
        expect(await messages({ level: "warn" })).toEqual(["error", "warn"]);
        expect(await messages({ level: "error" })).toEqual(["error"]);
        expect(await messages({ userId: "ubob" })).toEqual(["warn"]);
        expect(await messages({ since: now - 2_500, until: now - 1_500 })).toEqual(["warn"]);
        expect((await store.read({ level: "error" }, 50, now)).entries[0]?.data).toEqual({
            stack: "at x",
        });
    });

    it("drops what one person reports past the minute's rate and bounds large data", async () => {
        const base = await folder();
        const stores = new ArtifactDataStores((artifactId) => join(base, artifactId));
        const ctx = createRootContext();
        closers.push(() => stores.close(ctx));
        const entry = { level: "warn" as const, source: "console" as const, message: "noisy" };
        let accepted = 0;
        let dropped = 0;
        for (let batch = 0; batch < 3; batch += 1) {
            const result = await stores.appendLogs(ctx, "art", {
                userId: "uana",
                version: 2,
                batch: { entries: Array.from({ length: 50 }, () => entry) },
            });
            accepted += result.accepted;
            dropped += result.dropped;
        }
        expect(accepted).toBe(ARTIFACT_LOG_LIMITS.entriesPerMinute);
        expect(dropped).toBe(150 - ARTIFACT_LOG_LIMITS.entriesPerMinute);
        // Another person has a rate of their own.
        const other = await stores.appendLogs(ctx, "art", {
            userId: "ubob",
            version: 2,
            batch: { entries: [{ ...entry, data: { blob: "x".repeat(20_000) } }] },
        });
        expect(other).toEqual({ accepted: 1, dropped: 0 });
        const [newest] = (await stores.readLogs(ctx, "art", { userId: "ubob" })).entries;
        expect(newest).toMatchObject({ userId: "ubob", version: 2 });
        expect(JSON.stringify(newest?.data).length).toBeLessThan(1_200);
        expect((await stores.readLogs(ctx, "never-written")).entries).toEqual([]);
    });
});
