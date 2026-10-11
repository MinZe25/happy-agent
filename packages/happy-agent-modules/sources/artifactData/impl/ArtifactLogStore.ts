import { pathToFileURL } from "node:url";

import { createClient, type Client, type InArgs } from "@libsql/client";

import {
    ARTIFACT_LOG_LIMITS,
    type ArtifactLogEntry,
    type ArtifactLogLevel,
    type ArtifactLogPage,
    type ArtifactLogQuery,
    type ArtifactLogSource,
} from "../ArtifactData.js";

const SCHEMA_VERSION = 1;

const SCHEMA = [
    `CREATE TABLE logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        client_at INTEGER,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        user_id TEXT NOT NULL,
        version INTEGER,
        url TEXT
    ) STRICT`,
    `CREATE INDEX logs_at ON logs (at)`,
];

const SEVERITY: Record<ArtifactLogLevel, number> = { info: 0, warn: 1, error: 2 };

/** One entry ready to keep: already bounded and validated by the caller. */
export interface ArtifactLogRecord {
    readonly at: number;
    readonly clientAt: number | null;
    readonly level: ArtifactLogLevel;
    readonly source: ArtifactLogSource;
    readonly message: string;
    readonly dataJson: string | null;
    readonly userId: string;
    readonly version: number | null;
    readonly url: string | null;
}

/**
 * One artifact's debug log in its own SQLite file: a ring of the newest entries pages reported,
 * bounded by count and age. Every call must be serialized by the caller.
 */
export class ArtifactLogStore {
    readonly #client: Client;

    private constructor(client: Client) {
        this.#client = client;
    }

    static async open(path: string): Promise<ArtifactLogStore> {
        const client = createClient({
            intMode: "number",
            timeout: 5_000,
            url: pathToFileURL(path).href,
        });
        try {
            await client.execute("PRAGMA journal_mode = WAL");
            await client.execute("PRAGMA synchronous = NORMAL");
            await client.execute("PRAGMA busy_timeout = 5000");
            const version = Number((await client.execute("PRAGMA user_version")).rows[0]?.[0] ?? 0);
            if (version > SCHEMA_VERSION) {
                throw new Error("The artifact log was written by a newer Happy Agent.");
            }
            if (version < SCHEMA_VERSION) {
                await client.batch(
                    [...SCHEMA, `PRAGMA user_version = ${String(SCHEMA_VERSION)}`],
                    "write",
                );
            }
            return new ArtifactLogStore(client);
        } catch (error: unknown) {
            client.close();
            throw error;
        }
    }

    close(): void {
        this.#client.close();
    }

    /** Keep the records, then forget everything past the ring's count and age. */
    async append(records: readonly ArtifactLogRecord[], now: number): Promise<void> {
        await this.#client.batch(
            [
                ...records.map((record) => ({
                    sql: `INSERT INTO logs (at, client_at, level, source, message, data_json, user_id, version, url)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [
                        record.at,
                        record.clientAt,
                        record.level,
                        record.source,
                        record.message,
                        record.dataJson,
                        record.userId,
                        record.version,
                        record.url,
                    ],
                })),
                {
                    sql: "DELETE FROM logs WHERE at < ? OR seq <= (SELECT max(seq) FROM logs) - ?",
                    args: [now - ARTIFACT_LOG_LIMITS.keptMs, ARTIFACT_LOG_LIMITS.keptEntries],
                },
            ],
            "write",
        );
    }

    async read(query: ArtifactLogQuery, limit: number, now: number): Promise<ArtifactLogPage> {
        const conditions = ["at >= ?"];
        const args: InArgs = [Math.max(query.since ?? 0, now - ARTIFACT_LOG_LIMITS.keptMs)];
        if (query.until !== undefined) {
            conditions.push("at <= ?");
            args.push(query.until);
        }
        if (query.before !== undefined) {
            conditions.push("seq < ?");
            args.push(Number(query.before));
        }
        if (query.userId !== undefined) {
            conditions.push("user_id = ?");
            args.push(query.userId);
        }
        if (query.level !== undefined && query.level !== "info") {
            const levels = (Object.keys(SEVERITY) as ArtifactLogLevel[]).filter(
                (level) => SEVERITY[level] >= SEVERITY[query.level ?? "info"],
            );
            conditions.push(`level IN (${levels.map(() => "?").join(", ")})`);
            args.push(...levels);
        }
        args.push(limit + 1);
        const rows = (
            await this.#client.execute({
                sql: `SELECT seq, at, client_at, level, source, message, data_json, user_id, version, url
                    FROM logs WHERE ${conditions.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
                args,
            })
        ).rows;
        const entries = rows.slice(0, limit).map(
            (row): ArtifactLogEntry => ({
                id: String(row["seq"]),
                at: Number(row["at"]),
                clientAt: row["client_at"] === null ? null : Number(row["client_at"]),
                level: String(row["level"]) as ArtifactLogLevel,
                source: String(row["source"]) as ArtifactLogSource,
                message: String(row["message"]),
                data:
                    row["data_json"] === null
                        ? null
                        : (JSON.parse(String(row["data_json"])) as unknown),
                userId: String(row["user_id"]),
                version: row["version"] === null ? null : Number(row["version"]),
                url: row["url"] === null ? null : String(row["url"]),
            }),
        );
        return {
            entries,
            nextBefore: rows.length > limit ? entries.at(-1)?.id : undefined,
        };
    }
}
