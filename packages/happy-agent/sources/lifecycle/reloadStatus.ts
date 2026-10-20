import { Type, type Static } from "@sinclair/typebox";
import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import type { DrainWaitingFor } from "@slopus/happy-agent-client";
import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HappyDaemonPaths } from "./getHappyDaemonPaths.js";

/** How often a running reload rewrites its status, so a reader can tell it is still alive. */
export const RELOAD_STATUS_HEARTBEAT_MS = 2_000;

const drainWaitingForSchema = Type.Object({
    name: Type.String(),
    count: Type.Integer({ minimum: 0 }),
    agents: Type.Optional(
        Type.Array(
            Type.Object({
                id: Type.String(),
                stage: Type.Union([
                    Type.Literal("compaction"),
                    Type.Literal("inference"),
                    Type.Literal("settlement"),
                    Type.Literal("tools"),
                ]),
            }),
        ),
    ),
    truncated: Type.Optional(Type.Literal(true)),
});

const runningPhaseSchema = Type.Union([
    Type.Literal("draining"),
    Type.Literal("stopping"),
    Type.Literal("starting"),
]);
export type ReloadRunningPhase = Static<typeof runningPhaseSchema>;

/**
 * What `reload.json` says about the reload under way or last finished.
 *
 * The file is the reload command's own report, so a client that did not start the reload can show
 * its real phases and elapsed time. The daemon cannot report this: it is gone between stopping and
 * starting. A reader treats an unreadable or unknown file as no reload, ignores fields it does not
 * know, and treats a running phase as abandoned once `pid` has exited or `updatedAt` has not moved
 * for several heartbeats. The file is never deleted; the next reload replaces it.
 */
export const reloadStatusSchema = Type.Object({
    format: Type.Literal(1),
    operationId: Type.String({ minLength: 1 }),
    /** The reload command's process, not the daemon's. */
    pid: Type.Integer({ minimum: 1 }),
    startedAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
    phase: Type.Union([runningPhaseSchema, Type.Literal("done"), Type.Literal("failed")]),
    phaseStartedAt: Type.Integer({ minimum: 0 }),
    /** The Happy Agent version being started. */
    version: Type.String(),
    /** Draining only: the daemon's own drain report, copied from health. */
    waitingFor: Type.Optional(Type.Array(drainWaitingForSchema)),
    /** Draining only: the most open work the drain has held at once. */
    waitingPeak: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Done or failed only. */
    finishedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Failed only: the phase that was running. */
    failedAt: Type.Optional(runningPhaseSchema),
    /** Failed only: what went wrong, in plain English. */
    message: Type.Optional(Type.String()),
});
export type ReloadStatus = Static<typeof reloadStatusSchema>;

export interface ReloadStatusReporter {
    phase(phase: ReloadRunningPhase): void;
    draining(waitingFor: readonly DrainWaitingFor[]): void;
    done(): void;
    failed(error: unknown): void;
    /** Stop the heartbeat and wait for the last write. */
    close(): Promise<void>;
}

/** Where a reload reports itself: `<happyHome>/agent/reload.json`. */
export function reloadStatusPath(paths: Pick<HappyDaemonPaths, "directory">): string {
    return join(paths.directory, "reload.json");
}

/**
 * Start reporting one reload, in its first phase.
 *
 * Every phase change is logged with how long the previous one took. The status file is optional
 * reporting: a write that fails is logged once and never fails the reload.
 */
export function startReloadStatus(
    paths: Pick<HappyDaemonPaths, "directory">,
    options: {
        readonly firstPhase: ReloadRunningPhase;
        readonly log: (line: string) => void;
        readonly version: string;
        readonly now?: () => number;
    },
): ReloadStatusReporter {
    const now = options.now ?? Date.now;
    const path = reloadStatusPath(paths);
    const temporaryPath = `${path}.${String(process.pid)}.tmp`;
    const startedAt = now();
    let status: ReloadStatus = {
        format: 1,
        operationId: randomUUID(),
        phase: options.firstPhase,
        phaseStartedAt: startedAt,
        pid: process.pid,
        startedAt,
        updatedAt: startedAt,
        version: options.version,
        ...(options.firstPhase === "draining" ? { waitingFor: [], waitingPeak: 0 } : {}),
    };
    // The daemon's directory usually exists already; a reload with no daemon may be the first.
    let writing = ensurePrivateDirectory(paths.directory).catch(() => undefined);
    let writeFailed = false;
    let closed = false;
    const write = (): void => {
        status = { ...status, updatedAt: now() };
        const content = `${JSON.stringify(status)}\n`;
        writing = writing.then(async () => {
            try {
                await writeFile(temporaryPath, content, { mode: 0o600 });
                await chmod(temporaryPath, 0o600);
                await rename(temporaryPath, path);
            } catch (error) {
                await rm(temporaryPath, { force: true }).catch(() => undefined);
                if (!writeFailed) {
                    writeFailed = true;
                    options.log(
                        `reload:status:unwritable path=${path} error=${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
        });
    };
    const transition = (next: ReloadStatus): void => {
        const at = now();
        options.log(
            `reload:phase phase=${next.phase} previous=${status.phase} previousDurationMs=${String(
                at - status.phaseStartedAt,
            )} elapsedMs=${String(at - startedAt)}`,
        );
        status = next;
        write();
    };
    options.log(`reload:phase phase=${status.phase} elapsedMs=0 operationId=${status.operationId}`);
    write();
    const heartbeat = setInterval(write, RELOAD_STATUS_HEARTBEAT_MS);
    heartbeat.unref();
    const base = (): ReloadStatus => ({
        format: 1,
        operationId: status.operationId,
        phase: status.phase,
        phaseStartedAt: status.phaseStartedAt,
        pid: status.pid,
        startedAt,
        updatedAt: status.updatedAt,
        version: status.version,
    });
    const stop = (): void => {
        closed = true;
        clearInterval(heartbeat);
    };
    const setPhase = (phase: ReloadRunningPhase): void => {
        if (closed || phase === status.phase) return;
        transition({
            ...base(),
            phase,
            phaseStartedAt: now(),
            ...(phase === "draining" ? { waitingFor: [], waitingPeak: 0 } : {}),
        });
    };
    return {
        phase: setPhase,
        draining(waitingFor) {
            if (closed) return;
            setPhase("draining");
            const total = waitingFor.reduce((sum, row) => sum + row.count, 0);
            status = {
                ...status,
                waitingFor: waitingFor.map((row) => ({
                    count: row.count,
                    name: row.name,
                    ...(row.agents === undefined
                        ? {}
                        : {
                              agents: row.agents.map((agent) => ({
                                  id: agent.id,
                                  stage: agent.stage,
                              })),
                          }),
                    ...(row.truncated === true ? { truncated: true as const } : {}),
                })),
                waitingPeak: Math.max(status.waitingPeak ?? 0, total),
            };
            write();
        },
        done() {
            if (closed) return;
            const finishedAt = now();
            transition({ ...base(), finishedAt, phase: "done", phaseStartedAt: finishedAt });
            options.log(`reload:finish durationMs=${String(finishedAt - startedAt)}`);
            stop();
        },
        failed(error) {
            if (closed) return;
            const finishedAt = now();
            const failedAt =
                status.phase === "done" || status.phase === "failed" ? "starting" : status.phase;
            transition({
                ...base(),
                failedAt,
                finishedAt,
                message: error instanceof Error ? error.message : String(error),
                phase: "failed",
                phaseStartedAt: finishedAt,
            });
            options.log(
                `reload:fail failedAt=${failedAt} durationMs=${String(finishedAt - startedAt)}`,
            );
            stop();
        },
        async close() {
            stop();
            await writing;
        },
    };
}
