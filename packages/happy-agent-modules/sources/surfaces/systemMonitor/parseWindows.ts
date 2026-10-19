import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SystemMonitorDisk, SystemMonitorGpu } from "@slopus/happy-agent-client";
import { numberOrNull, rawProcessSchema, type RawProcess } from "./parseProcess.js";

const numeric = Type.Union([Type.Number({ minimum: 0 }), Type.String({ pattern: "^\\d+$" })]);
const processRows = Type.Array(
    Type.Object({
        ProcessId: numeric,
        ParentProcessId: numeric,
        Name: Type.String(),
        WorkingSetSize: numeric,
        ThreadCount: numeric,
        KernelModeTime: numeric,
        UserModeTime: numeric,
        Started: Type.Union([Type.String(), Type.Null()]),
    }),
    { maxItems: 20000 },
);
const diskRows = Type.Array(
    Type.Object({
        DeviceID: Type.String(),
        FileSystem: Type.Union([Type.String(), Type.Null()]),
        Size: numeric,
        FreeSpace: numeric,
    }),
);
const gpuRows = Type.Array(
    Type.Object({
        Name: Type.String(),
        AdapterCompatibility: Type.Union([Type.String(), Type.Null()]),
    }),
);
function json(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
export function parseWindowsProcesses(text: string): RawProcess[] | null {
    const rows = json(text);
    if (!Value.Check(processRows, rows)) return null;
    return rows.flatMap((row) => {
        if (Number(row.ProcessId) === 0) return []; // The idle pseudo-process is not application CPU usage.
        const start = row.Started === null ? NaN : Date.parse(row.Started);
        const item = {
            pid: Number(row.ProcessId),
            parentPid: Number(row.ParentProcessId),
            name: row.Name.split(/[\\/]/).at(-1)!,
            user: null,
            state: null,
            cpuPercent: null,
            memoryBytes: Number(row.WorkingSetSize),
            threads: Number(row.ThreadCount),
            startedAt: Number.isFinite(start) ? Math.max(0, start) : null,
            startIdentity: row.Started ?? "unknown",
            cpuTime: (Number(row.KernelModeTime) + Number(row.UserModeTime)) / 10000,
        };
        return Value.Check(rawProcessSchema, item) ? [item] : [];
    });
}
export function parseWindowsDisks(text: string): SystemMonitorDisk[] {
    const rows = json(text);
    if (!Value.Check(diskRows, rows)) return [];
    return rows.flatMap((r) => {
        const total = numberOrNull(r.Size),
            available = numberOrNull(r.FreeSpace);
        return total === null || available === null
            ? []
            : [
                  {
                      device: r.DeviceID,
                      mountPoint: `${r.DeviceID}\\`,
                      fileSystem: r.FileSystem,
                      totalBytes: total,
                      availableBytes: Math.min(total, available),
                      usedBytes: Math.max(0, total - available),
                  },
              ];
    });
}
export function parseWindowsGpus(text: string): SystemMonitorGpu[] {
    const rows = json(text);
    if (!Value.Check(gpuRows, rows)) return [];
    return rows.map((r) => {
        const vendor = `${r.Name} ${r.AdapterCompatibility ?? ""}`.toLowerCase();
        return {
            name: r.Name,
            vendor: vendor.includes("nvidia")
                ? "nvidia"
                : vendor.includes("amd") || vendor.includes("advanced micro")
                  ? "amd"
                  : vendor.includes("intel")
                    ? "intel"
                    : "other",
            usagePercent: null,
            memoryTotalBytes: null,
            memoryUsedBytes: null,
            temperatureCelsius: null,
            powerWatts: null,
        };
    });
}
