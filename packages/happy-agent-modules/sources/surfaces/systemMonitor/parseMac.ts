import { Value } from "@sinclair/typebox/value";
import type {
    SystemMonitorGpu,
    SystemMonitorDisk,
    SystemMonitorSnapshot,
} from "@slopus/happy-agent-client";
import {
    numberOrNull,
    percent,
    processState,
    rawProcessSchema,
    type RawProcess,
} from "./parseProcess.js";

export function parseMacMemory(
    vm: string,
    total: number,
    swap: string,
): SystemMonitorSnapshot["memory"] | null {
    const pageSize = numberOrNull(/page size of (\d+) bytes/.exec(vm)?.[1]);
    const pages = new Map(
        [...vm.matchAll(/^([^:\n]+):\s+(\d+)\./gm)].map((m) => [m[1]!, Number(m[2])]),
    );
    if (pageSize === null || !pages.has("Pages wired down") || !pages.has("Anonymous pages"))
        return null;
    // File-backed cache is reclaimable. Compressed pages occupy their actual compressor footprint.
    const usedPages =
        (pages.get("Anonymous pages") ?? 0) +
        (pages.get("Pages wired down") ?? 0) +
        (pages.get("Pages occupied by compressor") ?? 0) -
        (pages.get("Pages purgeable") ?? 0);
    const used = Math.min(total, Math.max(0, usedPages * pageSize));
    const bytes = (key: string) => {
        const match = new RegExp(`${key} = ([0-9.]+)([KMG])`).exec(swap);
        return match === null
            ? null
            : Number(match[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2]!] ?? 1);
    };
    return {
        totalBytes: total,
        usedBytes: used,
        availableBytes: total - used,
        cachedBytes: (pages.get("File-backed pages") ?? 0) * pageSize,
        swapTotalBytes: bytes("total"),
        swapUsedBytes: bytes("used"),
    };
}
/** ps TIME is cumulative CPU, in [[days-]hours:]minutes:seconds[.fraction]. */
export function parsePsTime(value: string): number | null {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
    if (match === null) return null;
    return (
        (Number(match[1] ?? 0) * 86400 +
            Number(match[2] ?? 0) * 3600 +
            Number(match[3]) * 60 +
            Number(match[4])) *
        1000
    );
}
/** Fixed ps columns followed by comm; comm contains an executable path, never arguments. */
export function parseMacProcesses(text: string): RawProcess[] {
    const result: RawProcess[] = [];
    for (const line of text.split("\n")) {
        const m =
            /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(
                line,
            );
        if (m === null) continue;
        const started = Date.parse(m[7]!);
        const row = {
            pid: Number(m[1]),
            parentPid: Number(m[2]),
            user: m[3],
            state: processState(m[4]!),
            memoryBytes: Number(m[5]) * 1024,
            cpuTime: parsePsTime(m[6]!),
            cpuPercent: null,
            startedAt: Number.isFinite(started) ? Math.max(0, started) : null,
            startIdentity: m[7]!,
            name: m[8]!.split("/").at(-1)!,
            threads: null,
        };
        if (Value.Check(rawProcessSchema, row)) result.push(row);
    }
    return result;
}
export function parseMacDisks(text: string): SystemMonitorDisk[] {
    return text.split("\n").flatMap((line) => {
        const m = /^(\/dev\/\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
        return m === null
            ? []
            : [
                  {
                      device: m[1]!,
                      totalBytes: Number(m[2]) * 1024,
                      usedBytes: Number(m[3]) * 1024,
                      availableBytes: Number(m[4]) * 1024,
                      mountPoint: m[5]!,
                      fileSystem: null,
                  },
              ];
    });
}
/** ioreg's property-list text uses numeric dictionary members for accelerator statistics. */
export function parseMacGpus(text: string, model: string): SystemMonitorGpu[] {
    return text
        .split(/\+-o /)
        .slice(1)
        .flatMap((entry) => {
            if (!entry.includes('"PerformanceStatistics"')) return [];
            const field = (key: string) =>
                numberOrNull(new RegExp(`"${key}"\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(entry)?.[1]);
            const usage = field("Device Utilization %") ?? field("GPU Activity\\(%\\)");
            const name =
                /"model"\s*=\s*(?:<)?"([^"]+)"/.exec(entry)?.[1] ??
                (model.startsWith("Apple") ? `${model} GPU` : "Intel GPU");
            return [
                {
                    name,
                    vendor: model.startsWith("Apple") ? ("apple" as const) : ("intel" as const),
                    usagePercent: usage === null ? null : percent(usage),
                    memoryTotalBytes: null,
                    memoryUsedBytes: field("In use system memory"),
                    temperatureCelsius: null,
                    powerWatts: null,
                },
            ];
        });
}
export function parseMacDiskIo(text: string): { read: number; write: number } | null {
    const reads = [...text.matchAll(/"Bytes \(Read\)"\s*=\s*(\d+)/g)];
    const writes = [...text.matchAll(/"Bytes \(Write\)"\s*=\s*(\d+)/g)];
    if (reads.length === 0 || reads.length !== writes.length) return null;
    return {
        read: reads.reduce((n, m) => n + Number(m[1]), 0),
        write: writes.reduce((n, m) => n + Number(m[1]), 0),
    };
}
