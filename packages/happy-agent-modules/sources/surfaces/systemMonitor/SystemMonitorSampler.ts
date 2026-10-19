import os from "node:os";
import { detach, withLifetime, type Context, type RootContext } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import {
    systemMonitorSnapshotSchema,
    type SystemMonitorHistoryPoint,
    type SystemMonitorProcess,
    type SystemMonitorSnapshot,
} from "@slopus/happy-agent-client";
import { HostProbes } from "./HostProbes.js";
import { percent, processLeaders, type RawProcess } from "./parseProcess.js";

export const SYSTEM_MONITOR_INTERVAL_MS = 1000;
export const SYSTEM_MONITOR_IDLE_MS = 60000;
export const SYSTEM_MONITOR_HISTORY_LIMIT = 300;
const PROBE_TIMEOUT_MS = 1200;

/** One ephemeral sampler per daemon. Every probe has its own bounded, non-overlapping lane. */
export class SystemMonitorSampler {
    readonly #root: RootContext;
    readonly #pending = new Set<string>();
    readonly #lastProbe = new Map<string, number>();
    #timer: ReturnType<typeof setTimeout> | undefined;
    #controller: AbortController | undefined;
    #ready: Promise<void> | undefined;
    #resolveReady: (() => void) | undefined;
    #lastRead = 0;
    #ticks = 0;
    #cpus: os.CpuInfo[] = [];
    #history: SystemMonitorHistoryPoint[] = [];
    #memory: SystemMonitorSnapshot["memory"] | null = null;
    #gpus: SystemMonitorSnapshot["gpus"] = [];
    #disks: SystemMonitorSnapshot["disks"] = [];
    #diskIo: SystemMonitorSnapshot["diskIo"] = null;
    #diskPrevious: { read: number; write: number; at: number } | undefined;
    #processes: SystemMonitorSnapshot["processes"] = null;
    #processPrevious:
        | { items: Map<number, RawProcess>; capacity: number | null; at: number }
        | undefined;
    #osName = `${os.type()} ${os.release()}`;
    #temperature: number | null = null;
    #snapshot: SystemMonitorSnapshot;

    constructor(ctx: Context) {
        const root = detach(ctx);
        this.#root = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        this.#snapshot = this.#base();
        ctx.lifetime?.addEventListener("abort", () => this.#stop(), { once: true });
    }
    async read(): Promise<SystemMonitorSnapshot> {
        this.#lastRead = Date.now();
        if (this.#controller === undefined && !this.#root.lifetime?.aborted) this.#start();
        if (this.#ready !== undefined) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    this.#ready,
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, 1500);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        }
        return this.#snapshot;
    }
    #start(): void {
        const controller = new AbortController();
        this.#controller = controller;
        this.#ticks = 0;
        this.#cpus = [];
        this.#processPrevious = undefined;
        this.#diskPrevious = undefined;
        this.#diskIo = null;
        this.#processes = null;
        this.#memory = null;
        this.#gpus = [];
        this.#disks = [];
        this.#temperature = null;
        this.#lastProbe.clear();
        this.#ready = new Promise((resolve) => {
            this.#resolveReady = resolve;
        });
        const lifetime =
            this.#root.lifetime === undefined
                ? controller.signal
                : AbortSignal.any([controller.signal, this.#root.lifetime]);
        const ctx = withLifetime(this.#root.named("system-monitor-sampler"), lifetime);
        const probes = new HostProbes(ctx);
        const tick = () => {
            if (lifetime.aborted || Date.now() - this.#lastRead >= SYSTEM_MONITOR_IDLE_MS) {
                this.#stop();
                return;
            }
            this.#probe(
                "memory",
                1000,
                () => probes.memory(),
                (value) => {
                    this.#memory = value;
                },
                null,
            );
            this.#probe(
                "gpus",
                process.platform === "win32" ? 5000 : 1000,
                () => probes.gpus(),
                (value) => {
                    this.#gpus = value;
                },
                [],
            );
            this.#probe(
                "disks",
                5000,
                () => probes.disks(),
                (value) => {
                    this.#disks = value;
                },
                [],
            );
            this.#probe(
                "osName",
                60000,
                () => probes.osName(),
                (value) => {
                    this.#osName = value;
                },
                this.#osName,
            );
            this.#probe(
                "temperature",
                5000,
                () => probes.cpuTemperature(),
                (value) => {
                    this.#temperature = value;
                },
                null,
            );
            this.#probe(
                "diskIo",
                1000,
                () => probes.diskIo(),
                (value) => {
                    const at = performance.now(),
                        old = this.#diskPrevious;
                    this.#diskPrevious = value === null ? undefined : { ...value, at };
                    this.#diskIo =
                        value === null ||
                        old === undefined ||
                        at <= old.at ||
                        value.read < old.read ||
                        value.write < old.write
                            ? null
                            : {
                                  readBytesPerSecond:
                                      ((value.read - old.read) / (at - old.at)) * 1000,
                                  writeBytesPerSecond:
                                      ((value.write - old.write) / (at - old.at)) * 1000,
                              };
                },
                null,
            );
            this.#probe(
                "processes",
                process.platform === "win32" ? 5000 : 1000,
                () => probes.processes(),
                (value) => {
                    if (value === null) {
                        this.#processes = null;
                        this.#processPrevious = undefined;
                        return;
                    }
                    const at = performance.now(),
                        old = this.#processPrevious;
                    const capacity =
                        process.platform === "linux"
                            ? value.capacity === null || old?.capacity === null || old === undefined
                                ? null
                                : value.capacity - old.capacity
                            : old === undefined
                              ? null
                              : (at - old.at) * Math.max(1, os.cpus().length);
                    const items: SystemMonitorProcess[] = value.items.map(
                        ({ cpuTime, startIdentity, ...item }) => {
                            const previous = old?.items.get(item.pid);
                            const cpu =
                                capacity === null ||
                                capacity <= 0 ||
                                previous === undefined ||
                                previous.startIdentity !== startIdentity ||
                                cpuTime < previous.cpuTime
                                    ? null
                                    : percent(((cpuTime - previous.cpuTime) / capacity) * 100);
                            return { ...item, cpuPercent: cpu };
                        },
                    );
                    this.#processes = processLeaders(items, value.total);
                    this.#processPrevious = {
                        at,
                        capacity: value.capacity,
                        items: new Map(value.items.map((item) => [item.pid, item])),
                    };
                },
                null,
            );
            const snapshot = this.#base();
            const point: SystemMonitorHistoryPoint = {
                sampledAt: snapshot.sampledAt,
                cpuPercent: snapshot.cpu.usagePercent,
                memoryUsedBytes: snapshot.memory.usedBytes,
                gpuPercent: snapshot.gpus.reduce<number | null>(
                    (max, gpu) =>
                        gpu.usagePercent === null ? max : Math.max(max ?? 0, gpu.usagePercent),
                    null,
                ),
                diskReadBytesPerSecond: snapshot.diskIo?.readBytesPerSecond ?? null,
                diskWriteBytesPerSecond: snapshot.diskIo?.writeBytesPerSecond ?? null,
            };
            this.#history = [...this.#history, point].slice(-SYSTEM_MONITOR_HISTORY_LIMIT);
            const next = { ...snapshot, history: this.#history };
            if (Value.Check(systemMonitorSnapshotSchema, next)) this.#snapshot = next;
            if (++this.#ticks >= 2) {
                this.#resolveReady?.();
                this.#resolveReady = undefined;
                this.#ready = undefined;
            }
            this.#timer = setTimeout(tick, SYSTEM_MONITOR_INTERVAL_MS);
            this.#timer.unref();
        };
        tick();
    }
    /** Timed-out filesystem work remains in its lane until it actually settles, preventing buildup. */
    #probe<T>(
        name: string,
        interval: number,
        run: () => Promise<T>,
        apply: (value: T) => void,
        fallback: T,
    ): void {
        if (
            this.#pending.has(name) ||
            Date.now() - (this.#lastProbe.get(name) ?? -Infinity) < interval
        )
            return;
        const controller = this.#controller;
        this.#pending.add(name);
        this.#lastProbe.set(name, Date.now());
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            if (this.#controller === controller) apply(fallback);
        }, PROBE_TIMEOUT_MS);
        timer.unref();
        void run()
            .then(
                (value) => {
                    if (!expired && this.#controller === controller) apply(value);
                },
                () => {
                    if (this.#controller === controller) apply(fallback);
                },
            )
            .finally(() => {
                clearTimeout(timer);
                this.#pending.delete(name);
            });
    }
    #base(): SystemMonitorSnapshot {
        let cpus: os.CpuInfo[] = [];
        try {
            cpus = os.cpus();
        } catch {
            /* CPU telemetry can be unavailable on restricted hosts. */
        }
        const previous = this.#cpus;
        this.#cpus = cpus;
        const total = (cpu: os.CpuInfo) => Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const perCore =
            previous.length !== cpus.length ||
            cpus.length === 0 ||
            cpus.some((cpu, i) => total(cpu) <= total(previous[i]!))
                ? null
                : cpus.map((cpu, i) => {
                      const ticks = total(cpu) - total(previous[i]!);
                      return percent(
                          (1 - (cpu.times.idle - previous[i]!.times.idle) / ticks) * 100,
                      );
                  });
        const totalBytes = os.totalmem(),
            availableBytes = Math.min(totalBytes, os.freemem());
        const load = os.loadavg();
        return {
            sampledAt: Date.now(),
            intervalMs: SYSTEM_MONITOR_INTERVAL_MS,
            host: {
                hostname: os.hostname(),
                platform: process.platform,
                arch: process.arch,
                osName: this.#osName,
                uptimeSeconds: os.uptime(),
            },
            cpu: {
                model: cpus[0]?.model ?? "Unknown processor",
                logicalCores: cpus.length,
                usagePercent:
                    perCore === null ? null : perCore.reduce((a, b) => a + b, 0) / perCore.length,
                perCoreUsagePercent: perCore,
                loadAverage: process.platform === "win32" ? null : [load[0]!, load[1]!, load[2]!],
                speedMhz:
                    cpus.length === 0
                        ? null
                        : cpus.reduce((sum, cpu) => sum + cpu.speed, 0) / cpus.length || null,
                temperatureCelsius: this.#temperature,
            },
            memory: this.#memory ?? {
                totalBytes,
                availableBytes,
                usedBytes: totalBytes - availableBytes,
                cachedBytes: null,
                swapTotalBytes: null,
                swapUsedBytes: null,
            },
            gpus: this.#gpus,
            disks: this.#disks,
            diskIo: this.#diskIo,
            processes: this.#processes,
            history: [],
        };
    }
    #stop(): void {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#controller?.abort();
        this.#controller = undefined;
        this.#resolveReady?.();
        this.#resolveReady = undefined;
        this.#ready = undefined;
        this.#cpus = [];
        this.#processPrevious = undefined;
        this.#diskPrevious = undefined;
    }
}
