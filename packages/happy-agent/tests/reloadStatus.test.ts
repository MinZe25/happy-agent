import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
    reloadStatusPath,
    reloadStatusSchema,
    startReloadStatus,
    type ReloadStatus,
} from "../sources/lifecycle/reloadStatus.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })),
    );
});

async function directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "reload-status-"));
    directories.push(path);
    return path;
}

async function read(path: string): Promise<ReloadStatus> {
    const parsed: unknown = JSON.parse(
        await readFile(reloadStatusPath({ directory: path }), "utf8"),
    );
    expect(Value.Check(reloadStatusSchema, parsed)).toBe(true);
    return parsed as ReloadStatus;
}

describe("reload status", () => {
    it("reports every phase of one reload with its start time, drain report, and finish", async () => {
        const path = await directory();
        const lines: string[] = [];
        let clock = 1_000;
        const status = startReloadStatus(
            { directory: path },
            {
                firstPhase: "draining",
                log: (line) => lines.push(line),
                now: () => clock,
                version: "9.9.9",
            },
        );
        status.draining([
            {
                count: 2,
                name: "agent-system",
                agents: [
                    { id: "a", stage: "tools" },
                    { id: "b", stage: "inference" },
                ],
            },
        ]);
        clock = 4_000;
        status.draining([
            { count: 1, name: "agent-system", agents: [{ id: "a", stage: "tools" }] },
        ]);
        await status.close();
        const draining = await read(path);
        expect(draining).toMatchObject({
            format: 1,
            phase: "draining",
            phaseStartedAt: 1_000,
            pid: process.pid,
            startedAt: 1_000,
            version: "9.9.9",
            waitingFor: [{ count: 1, name: "agent-system", agents: [{ id: "a", stage: "tools" }] }],
            waitingPeak: 2,
        });

        const second = startReloadStatus(
            { directory: path },
            {
                firstPhase: "draining",
                log: (line) => lines.push(line),
                now: () => clock,
                version: "9.9.9",
            },
        );
        clock = 5_000;
        second.phase("stopping");
        clock = 6_000;
        second.phase("starting");
        clock = 9_000;
        second.done();
        await second.close();

        const done = await read(path);
        expect(done.operationId).not.toBe(draining.operationId);
        expect(done).toMatchObject({ finishedAt: 9_000, phase: "done", startedAt: 4_000 });
        expect(done).not.toHaveProperty("waitingFor");
        expect(lines).toContain(
            "reload:phase phase=stopping previous=draining previousDurationMs=1000 elapsedMs=1000",
        );
        expect(lines).toContain(
            "reload:phase phase=starting previous=stopping previousDurationMs=1000 elapsedMs=2000",
        );
        expect(lines).toContain("reload:finish durationMs=5000");
        expect((await stat(reloadStatusPath({ directory: path }))).mode & 0o777).toBe(0o600);
        // Every write replaced the file whole, leaving nothing half-written behind.
        expect(await readdir(path)).toEqual(["reload.json"]);
    });

    it("names the phase a failed reload stopped in", async () => {
        const path = await directory();
        const status = startReloadStatus(
            { directory: path },
            { firstPhase: "starting", log: () => undefined, now: () => 7_000, version: "1.0.0" },
        );
        status.failed(new Error("The local daemon could not be started."));
        status.done();
        await status.close();

        expect(await read(path)).toMatchObject({
            failedAt: "starting",
            finishedAt: 7_000,
            message: "The local daemon could not be started.",
            phase: "failed",
        });
    });

    it("never fails the reload when the status cannot be written", async () => {
        const lines: string[] = [];
        const blocker = join(await directory(), "blocker");
        await writeFile(blocker, "");
        const status = startReloadStatus(
            { directory: join(blocker, "agent") },
            { firstPhase: "starting", log: (line) => lines.push(line), version: "1.0.0" },
        );
        status.done();
        await expect(status.close()).resolves.toBeUndefined();
        expect(lines.filter((line) => line.startsWith("reload:status:unwritable"))).toHaveLength(1);
    });
});
