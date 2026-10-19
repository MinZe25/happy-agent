import { Value } from "@sinclair/typebox/value";
import type { SystemMonitorGpu, SystemMonitorSnapshot } from "@slopus/happy-agent-client";
import {
    numberOrNull,
    percent,
    processState,
    rawProcessSchema,
    type RawProcess,
} from "./parseProcess.js";

/** AMD sysfs reports percentages, byte counters, and hwmon millidegrees. */
export function parseLinuxGpu(
    readings: Record<"vendorId" | "busy" | "total" | "used" | "temperature", string>,
): SystemMonitorGpu {
    const vendorId = readings.vendorId.trim();
    const vendor =
        vendorId === "0x1002"
            ? "amd"
            : vendorId === "0x8086"
              ? "intel"
              : vendorId === "0x10de"
                ? "nvidia"
                : "other";
    const busy = numberOrNull(readings.busy.trim()),
        temp = numberOrNull(readings.temperature.trim());
    return {
        name:
            vendor === "amd"
                ? "AMD Radeon GPU"
                : vendor === "intel"
                  ? "Intel GPU"
                  : vendor === "nvidia"
                    ? "NVIDIA GPU"
                    : "Graphics processor",
        vendor,
        usagePercent: busy === null ? null : percent(busy),
        memoryTotalBytes: numberOrNull(readings.total.trim()),
        memoryUsedBytes: numberOrNull(readings.used.trim()),
        temperatureCelsius: temp === null ? null : temp / 1000,
        powerWatts: null,
    };
}

/** procfs uses KiB even though its labels say kB. */
export function parseLinuxMemory(text: string): SystemMonitorSnapshot["memory"] | null {
    const values = new Map(
        [...text.matchAll(/^(\w+):\s+(\d+) kB$/gm)].map((m) => [m[1]!, Number(m[2]) * 1024]),
    );
    const total = values.get("MemTotal"),
        available = values.get("MemAvailable");
    if (total === undefined || available === undefined) return null;
    const swapTotal = values.get("SwapTotal"),
        swapFree = values.get("SwapFree");
    return {
        totalBytes: total,
        availableBytes: Math.min(total, available),
        usedBytes: Math.max(0, total - available),
        cachedBytes: (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0),
        swapTotalBytes: swapTotal ?? null,
        swapUsedBytes:
            swapTotal === undefined || swapFree === undefined
                ? null
                : Math.max(0, swapTotal - swapFree),
    };
}
/** Total USER_HZ ticks: guest time is already included in user/nice and must not be counted twice. */
export function parseLinuxCpuTicks(text: string): number | null {
    const line = /^cpu\s+(.+)$/m.exec(text)?.[1];
    if (line === undefined) return null;
    const values = line.trim().split(/\s+/).slice(0, 8).map(Number);
    return values.length >= 4 && values.every((v) => numberOrNull(v) !== null)
        ? values.reduce((a, b) => a + b, 0)
        : null;
}
/** comm may contain spaces and ')' characters; numeric fields begin after the final ')'. */
export function parseLinuxProcess(
    stat: string,
    status: string,
    clockTicks: number | null,
    bootMs: number | null,
): RawProcess | null {
    const begin = stat.indexOf("("),
        end = stat.lastIndexOf(")");
    if (begin < 1 || end <= begin) return null;
    const fields = stat
        .slice(end + 1)
        .trim()
        .split(/\s+/);
    const start = numberOrNull(fields[19]);
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1];
    if (start === null || (rss === undefined && numberOrNull(fields[21]) !== 0)) return null;
    const result = {
        pid: Number(stat.slice(0, begin).trim()),
        parentPid: Number(fields[1]),
        // procfs comm is an OS task name, not a command line or executable path. Kernel task
        // names such as kworker/u18:2 legitimately contain a slash.
        name: stat.slice(begin + 1, end),
        user: /^Uid:\s+(\d+)/m.exec(status)?.[1] ?? null,
        state: processState(fields[0] ?? ""),
        cpuPercent: null,
        cpuTime: Number(fields[11]) + Number(fields[12]),
        memoryBytes: Number(rss ?? 0) * 1024,
        threads: numberOrNull(fields[17]),
        startIdentity: String(start),
        startedAt:
            clockTicks === null || bootMs === null
                ? null
                : Math.floor(bootMs + (start / clockTicks) * 1000),
    };
    return Value.Check(rawProcessSchema, result) ? result : null;
}
/** Decode mountinfo's octal escaping and ignore pseudo-filesystems, bind-file mounts, and snaps. */
export function parseLinuxMounts(
    text: string,
): { mountPoint: string; device: string; fileSystem: string }[] {
    const decode = (s: string) =>
        s.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const real = new Set([
        "ext2",
        "ext3",
        "ext4",
        "xfs",
        "btrfs",
        "zfs",
        "vfat",
        "exfat",
        "ntfs",
        "ntfs3",
        "fuseblk",
        "f2fs",
        "bcachefs",
        "apfs",
        "hfsplus",
        "ufs",
        "nfs",
        "nfs4",
        "cifs",
        "smb3",
        "fuse.sshfs",
    ]);
    const result = new Map<string, { mountPoint: string; device: string; fileSystem: string }>();
    for (const line of text.split("\n")) {
        const [left, right] = line.split(" - ");
        if (left === undefined || right === undefined) continue;
        const fields = left.split(" "),
            [fileSystem, device] = right.split(" ");
        if (
            fileSystem === undefined ||
            !real.has(fileSystem) ||
            device === undefined ||
            fields[4] === undefined
        )
            continue;
        const mountPoint = decode(fields[4]);
        result.set(mountPoint, { mountPoint, device: decode(device), fileSystem });
    }
    return [...result.values()];
}
/** Only whole physical block devices supplied by sysfs, never partitions or mapped layers. */
export function parseLinuxDiskIo(
    text: string,
    devices: ReadonlySet<string>,
): { read: number; write: number } | null {
    let read = 0,
        write = 0,
        count = 0;
    for (const line of text.trim().split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (!devices.has(fields[2] ?? "")) continue;
        const r = numberOrNull(fields[5]),
            w = numberOrNull(fields[9]);
        if (r === null || w === null) continue;
        read += r * 512;
        write += w * 512;
        count++;
    }
    return count === 0 ? null : { read, write };
}
