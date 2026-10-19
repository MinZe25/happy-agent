import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    openAgentSQLiteDatabase,
} from "../../sources/index.js";
import { outsideAgentDatabaseOperation } from "../../sources/AgentDatabaseConnection.js";

const createdDirectories = new Set<string>();

afterEach(async () => {
    await Promise.all(
        [...createdDirectories].map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
    createdDirectories.clear();
});

describe("Agent Database SQLite concurrency", () => {
    it("reuses the initialized connection after committed and rolled-back transactions", async () => {
        const directory = await createTestDirectory();
        const opened = await openAgentSQLiteDatabase(join(directory, "agent.sqlite"));
        const { database } = opened;
        try {
            // Temporary tables belong to one native connection. Their survival
            // proves sequential transactions return it to the upstream pool.
            await agentDatabaseRun(
                database,
                sql`CREATE TEMP TABLE connection_probe (value TEXT NOT NULL)`,
            );
            await opened.transaction(async (tx) => {
                await agentDatabaseRun(tx, sql`INSERT INTO connection_probe VALUES ('committed')`);
            });
            await expect(
                opened.transaction(async (tx) => {
                    await agentDatabaseRun(
                        tx,
                        sql`INSERT INTO connection_probe VALUES ('rolled back')`,
                    );
                    throw new Error("rollback probe");
                }),
            ).rejects.toThrow("rollback probe");
            await expect(
                agentDatabaseRows(database, sql`SELECT value FROM connection_probe`),
            ).resolves.toEqual([{ value: "committed" }]);
        } finally {
            await opened.close();
        }
    });

    it("runs a repeated statement again after schema changes, failures, and a reopen", async () => {
        const directory = await createTestDirectory();
        const path = join(directory, "agent.sqlite");
        const opened = await openAgentSQLiteDatabase(path);
        const { database } = opened;
        const insert = (id: number) =>
            agentDatabaseRun(database, sql`INSERT INTO probe (id) VALUES (${id})`);
        const all = () => agentDatabaseRows(database, sql`SELECT * FROM probe ORDER BY id`);
        try {
            await agentDatabaseRun(database, sql`CREATE TABLE probe (id INTEGER PRIMARY KEY)`);
            await insert(1);
            await expect(all()).resolves.toEqual([{ id: 1 }]);
            // The same statement describes the columns a schema change added.
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE probe ADD COLUMN label TEXT NOT NULL DEFAULT 'none'`,
            );
            await expect(all()).resolves.toEqual([{ id: 1, label: "none" }]);
            // A statement that failed runs again with other values.
            await expect(insert(1)).rejects.toThrow();
            await insert(2);
            await expect(all()).resolves.toEqual([
                { id: 1, label: "none" },
                { id: 2, label: "none" },
            ]);
            // One whose table is gone fails, and works again once the table is back.
            await agentDatabaseRun(database, sql`DROP TABLE probe`);
            await expect(all()).rejects.toThrow();
            await agentDatabaseRun(database, sql`CREATE TABLE probe (id INTEGER PRIMARY KEY)`);
            await insert(3);
            await expect(all()).resolves.toEqual([{ id: 3 }]);
        } finally {
            await opened.close();
        }
        const reopened = await openAgentSQLiteDatabase(path);
        try {
            await expect(
                agentDatabaseRows(reopened.database, sql`SELECT * FROM probe ORDER BY id`),
            ).resolves.toEqual([{ id: 3 }]);
        } finally {
            await reopened.close();
        }
    });

    it("rejects a second connection until the process owner closes", async () => {
        const directory = await createTestDirectory();
        const path = join(directory, "agent.sqlite");
        const first = await openAgentSQLiteDatabase(path);
        try {
            expect((await stat(`${path}.lock`)).mode & 0o777).toBe(0o600);
            await expect(openAgentSQLiteDatabase(path)).rejects.toThrow(
                "The Agent SQLite database is already open in another process.",
            );
        } finally {
            await first.close();
        }

        const replacement = await openAgentSQLiteDatabase(path);
        await replacement.close();
    });

    it("treats symlinked parent directories as the same process owner", async () => {
        const directory = await createTestDirectory();
        const real = join(directory, "real");
        const alias = join(directory, "alias");
        await mkdir(real);
        await symlink(real, alias);
        const first = await openAgentSQLiteDatabase(join(alias, "agent.sqlite"));
        try {
            await expect(openAgentSQLiteDatabase(join(real, "agent.sqlite"))).rejects.toThrow(
                "The Agent SQLite database is already open in another process.",
            );
        } finally {
            await first.close();
        }
    });

    it("admits root operations in FIFO order without relying on elapsed time", async () => {
        const directory = await createTestDirectory();
        const opened = await openAgentSQLiteDatabase(join(directory, "agent.sqlite"));
        const entered = deferred<void>();
        const release = deferred<void>();
        let secondStarted = false;
        try {
            const first = opened.operation(opened.database, async () => {
                entered.resolve();
                await release.promise;
            });
            await entered.promise;
            const second = opened.operation(opened.database, async () => {
                secondStarted = true;
            });

            expect(secondStarted).toBe(false);
            release.resolve();
            await expect(Promise.all([first, second])).resolves.toBeDefined();
            expect(secondStarted).toBe(true);
        } finally {
            release.resolve();
            await opened.close();
        }
    });

    it("queues a root statement behind an active Agent Base transaction", async () => {
        const directory = await createTestDirectory();
        const opened = await openAgentSQLiteDatabase(join(directory, "agent.sqlite"));
        const { database } = opened;
        try {
            await agentDatabaseRun(database, sql`CREATE TABLE writes (value TEXT NOT NULL)`);
            await agentDatabaseRun(database, sql`PRAGMA busy_timeout = 1`);

            const entered = deferred<void>();
            const release = deferred<void>();
            const transaction = opened.transaction(async (tx) => {
                await agentDatabaseRun(tx, sql`INSERT INTO writes (value) VALUES ('transaction')`);
                entered.resolve();
                await release.promise;
            });
            await entered.promise;

            const rootWrite = agentDatabaseRun(
                database,
                sql`INSERT INTO writes (value) VALUES ('root')`,
            );
            release.resolve();

            await expect(Promise.all([transaction, rootWrite])).resolves.toBeDefined();
            await expect(
                agentDatabaseRows(database, sql`SELECT value FROM writes ORDER BY rowid`),
            ).resolves.toEqual([{ value: "transaction" }, { value: "root" }]);
        } finally {
            await opened.close();
        }
    });

    it("keeps the database slot through deterministic post-commit publication", async () => {
        const directory = await createTestDirectory();
        const opened = await openAgentSQLiteDatabase(join(directory, "agent.sqlite"));
        const committed = deferred<void>();
        const releasePublication = deferred<void>();
        let rootStarted = false;
        try {
            const transaction = opened.transaction(
                async () => undefined,
                async () => {
                    committed.resolve();
                    await releasePublication.promise;
                },
            );
            await committed.promise;
            const root = opened.operation(opened.database, async () => {
                rootStarted = true;
            });

            expect(rootStarted).toBe(false);
            releasePublication.resolve();
            await Promise.all([transaction, root]);
            expect(rootStarted).toBe(true);
        } finally {
            releasePublication.resolve();
            await opened.close();
        }
    });

    it("does not lend a database slot to an independent child lifetime", async () => {
        const directory = await createTestDirectory();
        const opened = await openAgentSQLiteDatabase(join(directory, "agent.sqlite"));
        const childEntered = deferred<void>();
        const releaseParent = deferred<void>();
        let childStarted = false;
        try {
            const parent = opened.operation(opened.database, async () => {
                void outsideAgentDatabaseOperation(async () => {
                    await opened.operation(opened.database, async () => {
                        childStarted = true;
                        childEntered.resolve();
                    });
                });
                expect(childStarted).toBe(false);
                releaseParent.resolve();
            });
            await parent;
            await childEntered.promise;
            expect(childStarted).toBe(true);
        } finally {
            releaseParent.resolve();
            await opened.close();
        }
    });

    it("drains admitted work before close and rejects later operations", async () => {
        const directory = await createTestDirectory();
        const opened = await openAgentSQLiteDatabase(join(directory, "agent.sqlite"));
        const entered = deferred<void>();
        const release = deferred<void>();
        const operation = opened.operation(opened.database, async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;

        const closing = opened.close();
        await expect(opened.operation(opened.database, async () => undefined)).rejects.toThrow(
            "closing",
        );
        release.resolve();

        await expect(Promise.all([operation, closing])).resolves.toBeDefined();
        await expect(opened.close()).resolves.toBeUndefined();
    });

    it("reuses a database-owned step and rejects closing it from inside itself", async () => {
        const directory = await createTestDirectory();
        const opened = await openAgentSQLiteDatabase(join(directory, "agent.sqlite"));
        try {
            await expect(
                opened.operation(opened.database, async () => {
                    await opened.operation(opened.database, async () => undefined);
                }),
            ).resolves.toBeUndefined();
            await expect(
                opened.operation(opened.database, async () => {
                    await opened.close();
                }),
            ).rejects.toThrow("cannot close");
        } finally {
            await opened.close();
        }
    });
});

async function createTestDirectory(): Promise<string> {
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "happy-agent-database-"));
    createdDirectories.add(directory);
    return directory;
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    resolve(value: Value): void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
