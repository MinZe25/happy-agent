import { createHash } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";

import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import { Value } from "@sinclair/typebox/value";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import {
    ARTIFACT_DATA_LIMITS,
    ARTIFACT_LOG_LIMITS,
    ArtifactDataCursorUnavailableError,
    ArtifactDataInputError,
    ArtifactDataTooLargeError,
    artifactDataChangesQuerySchema,
    artifactDataDeleteInputSchema,
    artifactDataKeySchema,
    artifactDataListQuerySchema,
    artifactDataSetInputSchema,
    artifactLogBatchSchema,
    artifactLogQuerySchema,
    DEFAULT_ARTIFACT_DATA_PAGE_SIZE,
    type ArtifactDataAuthor,
    type ArtifactDataChanges,
    type ArtifactDataChangesQuery,
    type ArtifactDataDeleteInput,
    type ArtifactDataEntry,
    type ArtifactDataListener,
    type ArtifactDataListQuery,
    type ArtifactDataPage,
    type ArtifactDataSetInput,
    type ArtifactDataSignal,
    type ArtifactDataWrite,
    type ArtifactLogBatch,
    type ArtifactLogPage,
    type ArtifactLogQuery,
} from "../ArtifactData.js";
import { ArtifactDataStore, type ArtifactDataOperation } from "./ArtifactDataStore.js";
import { ArtifactLogStore, type ArtifactLogRecord } from "./ArtifactLogStore.js";

/** Files kept open at once; the least recently used one closes when another opens. */
const MAX_OPEN_FILES = 32;
/** Users whose log rate is remembered at once. */
const MAX_RATE_BUCKETS = 4_096;

type OpenFile = ArtifactDataStore | ArtifactLogStore;

/**
 * Every artifact's data and debug log, each a SQLite file in the artifact's own directory. It
 * knows nothing of who the callers are or where the directories live; its owner decides both.
 *
 * Calls to one artifact's data are serialized, and committed changes reach subscribers in
 * version order. Nothing here knows whether an artifact exists; the caller decides that.
 */
export class ArtifactDataStores {
    readonly #directoryFor: (artifactId: string) => string;
    readonly #locks: MapAsyncLock<string> = mapAsyncLock();
    /** Open files by `data:<id>` or `logs:<id>`, least recently used first. */
    readonly #files = new Map<string, OpenFile>();
    readonly #listeners = new Map<string, Set<ArtifactDataListener>>();
    /** Log entries accepted this minute, by artifact and user. */
    readonly #rates = new Map<string, { minute: number; count: number }>();
    #closed = false;

    constructor(directoryFor: (artifactId: string) => string) {
        this.#directoryFor = directoryFor;
    }

    async get(
        ctx: Context,
        artifactId: string,
        key: string,
    ): Promise<{ readonly entry: ArtifactDataEntry | undefined; readonly cursor: string | null }> {
        if (!Value.Check(artifactDataKeySchema, key)) {
            throw new ArtifactDataInputError("The key is invalid.");
        }
        return await this.#readData(
            ctx,
            artifactId,
            () => ({ entry: undefined, cursor: null }),
            (store) => store.get(key),
        );
    }

    async list(
        ctx: Context,
        artifactId: string,
        query: ArtifactDataListQuery = {},
    ): Promise<ArtifactDataPage> {
        if (!Value.Check(artifactDataListQuerySchema, query)) {
            throw new ArtifactDataInputError("The list query is invalid.");
        }
        return await this.#readData(
            ctx,
            artifactId,
            () => ({ entries: [], nextAfter: undefined, cursor: null }),
            (store) =>
                store.list(
                    query.prefix ?? "",
                    query.after,
                    query.limit ?? DEFAULT_ARTIFACT_DATA_PAGE_SIZE,
                ),
        );
    }

    async changes(
        ctx: Context,
        artifactId: string,
        query: ArtifactDataChangesQuery = {},
    ): Promise<ArtifactDataChanges> {
        if (!Value.Check(artifactDataChangesQuerySchema, query)) {
            throw new ArtifactDataInputError("The changes query is invalid.");
        }
        return await this.#readData(
            ctx,
            artifactId,
            () => {
                // No write was ever made, so no cursor can have come from this store.
                if (query.since !== undefined) throw new ArtifactDataCursorUnavailableError();
                return { changes: [], cursor: null, hasMore: false };
            },
            (store) =>
                store.changes(
                    query.since,
                    query.prefix ?? "",
                    query.limit ?? DEFAULT_ARTIFACT_DATA_PAGE_SIZE,
                ),
        );
    }

    async set(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataSetInput,
    ): Promise<ArtifactDataWrite> {
        if (!Value.Check(artifactDataSetInputSchema, input)) {
            throw new ArtifactDataInputError("The write is invalid.");
        }
        let valueJson: string | undefined;
        try {
            valueJson = JSON.stringify(input.value);
        } catch {
            valueJson = undefined;
        }
        if (valueJson === undefined) throw new ArtifactDataInputError("The value must be JSON.");
        if (Buffer.byteLength(valueJson) > ARTIFACT_DATA_LIMITS.valueBytes) {
            throw new ArtifactDataTooLargeError("too_large", "The value is larger than 256 KiB.");
        }
        return await this.#write(
            ctx,
            artifactId,
            { kind: "set", key: input.key, valueJson },
            input,
        );
    }

    async delete(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataDeleteInput,
    ): Promise<ArtifactDataWrite> {
        if (!Value.Check(artifactDataDeleteInputSchema, input)) {
            throw new ArtifactDataInputError("The deletion is invalid.");
        }
        return await this.#write(ctx, artifactId, { kind: "delete", key: input.key }, input);
    }

    /** The agents behind the agent author IDs among `ids` that wrote to this artifact's data. */
    async agents(
        ctx: Context,
        artifactId: string,
        ids: readonly string[],
    ): Promise<ReadonlyMap<string, string>> {
        return await this.#readData(
            ctx,
            artifactId,
            () => new Map<string, string>(),
            (store) => store.agents(ids),
        );
    }

    /**
     * Copy entries from another store into this artifact's empty data, keeping versions and
     * authors. Returns `false`, changing nothing, when the artifact already holds data.
     */
    async importEntries(
        ctx: Context,
        artifactId: string,
        entries: readonly ArtifactDataEntry[],
    ): Promise<boolean> {
        return await this.#locks.runInLock(ctx, `data:${artifactId}`, async (lockCtx) => {
            const store = await this.#open(lockCtx, "data", artifactId, true);
            return await (store as ArtifactDataStore).importEntries(entries);
        });
    }

    /**
     * Keep a batch a page reported, as `userId` while the artifact's newest version is `version`.
     * Entries over the user's rate for this minute are dropped, and the counts of both returned.
     */
    async appendLogs(
        ctx: Context,
        artifactId: string,
        report: {
            readonly userId: string;
            readonly version: number | null;
            readonly batch: ArtifactLogBatch;
        },
    ): Promise<{ readonly accepted: number; readonly dropped: number }> {
        const { userId, version, batch } = report;
        if (!Value.Check(artifactLogBatchSchema, batch)) {
            throw new ArtifactDataInputError("The log batch is invalid.");
        }
        const now = Date.now();
        const allowed = this.#takeRate(`${artifactId}:${userId}`, batch.entries.length, now);
        const records: ArtifactLogRecord[] = batch.entries.slice(0, allowed).map((entry) => {
            let dataJson: string | null = null;
            if (entry.data !== undefined && entry.data !== null) {
                try {
                    dataJson = JSON.stringify(entry.data) ?? null;
                } catch {
                    dataJson = null;
                }
                if (
                    dataJson !== null &&
                    Buffer.byteLength(dataJson) > ARTIFACT_LOG_LIMITS.dataBytes
                ) {
                    dataJson = JSON.stringify({ truncated: dataJson.slice(0, 1024) });
                }
            }
            return {
                at: now,
                clientAt: entry.at ?? null,
                level: entry.level,
                source: entry.source,
                message: entry.message,
                dataJson,
                userId,
                version,
                url: batch.url ?? null,
            };
        });
        if (records.length > 0) {
            await this.#locks.runInLock(ctx, `logs:${artifactId}`, async (lockCtx) => {
                const store = await this.#open(lockCtx, "logs", artifactId, true);
                await (store as ArtifactLogStore).append(records, now);
            });
        }
        return { accepted: records.length, dropped: batch.entries.length - records.length };
    }

    /** Kept log entries, newest first. */
    async readLogs(
        ctx: Context,
        artifactId: string,
        query: ArtifactLogQuery = {},
    ): Promise<ArtifactLogPage> {
        if (!Value.Check(artifactLogQuerySchema, query)) {
            throw new ArtifactDataInputError("The log query is invalid.");
        }
        return await this.#locks.runInLock(ctx, `logs:${artifactId}`, async (lockCtx) => {
            const store = await this.#open(lockCtx, "logs", artifactId, false);
            if (store === undefined) return { entries: [], nextBefore: undefined };
            return await (store as ArtifactLogStore).read(
                query,
                query.limit ?? DEFAULT_LOG_PAGE_SIZE,
                Date.now(),
            );
        });
    }

    /**
     * Remove one artifact's data, or its log, from disk. Only a development server does this; the
     * daemon never erases data. Subscribers are not told; they find out when they next resume.
     */
    async discard(ctx: Context, artifactId: string, what: "data" | "logs"): Promise<void> {
        await this.#locks.runInLock(ctx, `${what}:${artifactId}`, async () => {
            const name = `${what}:${artifactId}`;
            this.#files.get(name)?.close();
            this.#files.delete(name);
            const file = join(this.#directoryFor(artifactId), FILE_NAMES[what]);
            for (const suffix of ["", "-wal", "-shm"]) {
                await rm(`${file}${suffix}`, { force: true });
            }
        });
    }

    /**
     * Hear every change to one artifact's data after it commits, in version order, until it is
     * ended or the stores close. Subscribing first and reading `changes` after misses nothing; a
     * change seen twice has the same version.
     */
    subscribe(artifactId: string, listener: ArtifactDataListener): () => void {
        if (this.#closed) {
            listener({ type: "closed", reason: "shutdown" });
            return () => undefined;
        }
        let listeners = this.#listeners.get(artifactId);
        if (listeners === undefined) {
            listeners = new Set();
            this.#listeners.set(artifactId, listeners);
        }
        listeners.add(listener);
        return () => {
            const current = this.#listeners.get(artifactId);
            current?.delete(listener);
            if (current?.size === 0) this.#listeners.delete(artifactId);
        };
    }

    /** Subscribers of one artifact, or of every artifact. */
    subscriberCount(artifactId?: string): number {
        if (artifactId !== undefined) return this.#listeners.get(artifactId)?.size ?? 0;
        let count = 0;
        for (const listeners of this.#listeners.values()) count += listeners.size;
        return count;
    }

    /** Tell one artifact's subscribers it no longer serves anyone, and forget them. */
    end(artifactId: string, reason: "artifact_deleted" | "shutdown"): void {
        this.#emit(artifactId, { type: "closed", reason });
        this.#listeners.delete(artifactId);
    }

    async close(ctx: Context): Promise<void> {
        this.#closed = true;
        for (const artifactId of [...this.#listeners.keys()]) this.end(artifactId, "shutdown");
        await Promise.all(
            [...this.#files.keys()].map(async (name) => {
                await this.#locks.runInLock(ctx, name, async () => {
                    this.#files.get(name)?.close();
                    this.#files.delete(name);
                });
            }),
        );
    }

    /** Read one artifact's data; data nobody wrote answers `absent()` without creating a file. */
    async #readData<Result>(
        ctx: Context,
        artifactId: string,
        absent: () => Result,
        read: (store: ArtifactDataStore) => Promise<Result>,
    ): Promise<Result> {
        return await this.#locks.runInLock(ctx, `data:${artifactId}`, async (lockCtx) => {
            const store = await this.#open(lockCtx, "data", artifactId, false);
            return store === undefined ? absent() : await read(store as ArtifactDataStore);
        });
    }

    async #write(
        ctx: Context,
        artifactId: string,
        operation: ArtifactDataOperation,
        input: ArtifactDataSetInput | ArtifactDataDeleteInput,
    ): Promise<ArtifactDataWrite> {
        return await this.#locks.runInLock(ctx, `data:${artifactId}`, async (lockCtx) => {
            const store = (await this.#open(
                lockCtx,
                "data",
                artifactId,
                true,
            )) as ArtifactDataStore;
            const result = await store.write(
                operation,
                artifactDataAuthorId(input.author),
                input.writeId,
                input.condition,
                Date.now(),
                input.author.kind === "agent" ? input.author.agentId : undefined,
            );
            // Still inside the lock, so subscribers hear changes in version order.
            if (result.changed) this.#emit(artifactId, { type: "change", entry: result.entry });
            return { entry: result.entry, replayed: result.replayed };
        });
    }

    /** The open file, opening it when needed; `undefined` when absent and not to be created. */
    async #open(
        ctx: Context,
        what: "data" | "logs",
        artifactId: string,
        create: boolean,
    ): Promise<OpenFile | undefined> {
        if (this.#closed) throw new Error("Artifact data is shutting down.");
        const name = `${what}:${artifactId}`;
        const open = this.#files.get(name);
        if (open !== undefined) {
            this.#files.delete(name);
            this.#files.set(name, open);
            return open;
        }
        const directory = this.#directoryFor(artifactId);
        const path = join(directory, FILE_NAMES[what]);
        if (!create && !(await exists(path))) return undefined;
        await ensurePrivateDirectory(directory);
        const file =
            what === "data"
                ? await ArtifactDataStore.open(path)
                : await ArtifactLogStore.open(path);
        this.#files.set(name, file);
        const [oldest] = this.#files.keys();
        if (this.#files.size > MAX_OPEN_FILES && oldest !== undefined && oldest !== name) {
            void this.#locks
                .runInLock(ctx, oldest, async () => {
                    const evicted = this.#files.get(oldest);
                    if (evicted === undefined || this.#files.size <= MAX_OPEN_FILES) return;
                    this.#files.delete(oldest);
                    evicted.close();
                })
                .catch(() => undefined);
        }
        return file;
    }

    #takeRate(bucket: string, wanted: number, now: number): number {
        const minute = Math.floor(now / 60_000);
        let rate = this.#rates.get(bucket);
        if (rate === undefined || rate.minute !== minute) {
            rate = { minute, count: 0 };
            this.#rates.delete(bucket);
            this.#rates.set(bucket, rate);
            if (this.#rates.size > MAX_RATE_BUCKETS) {
                const [oldest] = this.#rates.keys();
                if (oldest !== undefined) this.#rates.delete(oldest);
            }
        }
        const allowed = Math.max(
            0,
            Math.min(wanted, ARTIFACT_LOG_LIMITS.entriesPerMinute - rate.count),
        );
        rate.count += allowed;
        return allowed;
    }

    #emit(artifactId: string, signal: ArtifactDataSignal): void {
        for (const listener of [...(this.#listeners.get(artifactId) ?? [])]) {
            try {
                listener(signal);
            } catch {
                // One subscriber's failure is its own; the change is already committed.
            }
        }
    }
}

const DEFAULT_LOG_PAGE_SIZE = 50;

const FILE_NAMES = { data: "kv.sqlite", logs: "logs.sqlite" } as const;

/** The ID a page knows an author by; an agent's is derived so its own ID never reaches a page. */
export function artifactDataAuthorId(author: ArtifactDataAuthor): string {
    return author.kind === "user"
        ? author.userId
        : opaqueArtifactDataId("a", `happy-artifact-agent:${author.agentId}`);
}

/** A stable lowercase alphanumeric ID, starting with `first`, that cannot be reversed. */
export function opaqueArtifactDataId(first: string, seed: string): string {
    const digest = createHash("sha256").update(seed).digest();
    let id = first;
    for (const byte of digest.subarray(0, 23)) {
        id += "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36];
    }
    return id;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
