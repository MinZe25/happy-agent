import type { SystemMonitorProcess, SystemMonitorSnapshot } from "@slopus/happy-agent-client";

const percentage = (n: number | null) => (n === null ? "unavailable" : `${n.toFixed(1)}%`);
function bytes(n: number): string {
    if (n < 1024) return `${Math.round(n)} B`;
    const unit = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}
const processText = (p: SystemMonitorProcess) =>
    `${p.name} (PID ${p.pid}): CPU ${percentage(p.cpuPercent)}, memory ${bytes(p.memoryBytes)}`;
/** Keep tool text compact; the typed result retains the full bounded snapshot. */
export function formatSystemMonitor(snapshot: SystemMonitorSnapshot): string {
    const lines = [
        `${snapshot.host.hostname} — ${snapshot.host.osName}; sampled ${new Date(snapshot.sampledAt).toISOString()}`,
        `CPU: ${percentage(snapshot.cpu.usagePercent)} across ${snapshot.cpu.logicalCores} logical cores (${snapshot.cpu.model}).`,
        `Memory: ${bytes(snapshot.memory.usedBytes)} used of ${bytes(snapshot.memory.totalBytes)}; ${bytes(snapshot.memory.availableBytes)} available.`,
        ...snapshot.gpus.map(
            (gpu) =>
                `GPU ${gpu.name}: ${percentage(gpu.usagePercent)}${gpu.memoryUsedBytes === null ? "" : `; ${bytes(gpu.memoryUsedBytes)} memory used`}.`,
        ),
        ...(snapshot.gpus.length === 0 ? ["GPU: unavailable."] : []),
        ...snapshot.disks.map(
            (disk) =>
                `Disk ${disk.mountPoint}: ${bytes(disk.usedBytes)} used of ${bytes(disk.totalBytes)}; ${bytes(disk.availableBytes)} available.`,
        ),
        ...(snapshot.disks.length === 0 ? ["Disk capacity: unavailable."] : []),
        snapshot.diskIo === null
            ? "Disk activity: unavailable."
            : `Disk activity: ${bytes(snapshot.diskIo.readBytesPerSecond)}/s read, ${bytes(snapshot.diskIo.writeBytesPerSecond)}/s written.`,
    ];
    if (snapshot.processes === null) lines.push("Processes: unavailable.");
    else {
        lines.push(
            `Processes: ${snapshot.processes.total}${snapshot.processes.threads === null ? "" : `; ${snapshot.processes.threads} threads`}.`,
        );
        const byCpu = snapshot.processes.items.filter((p) => p.cpuPercent !== null).slice(0, 5);
        lines.push(
            "Top processes by CPU:",
            ...(byCpu.length === 0 ? ["CPU measurements unavailable."] : byCpu.map(processText)),
        );
        lines.push(
            "Top processes by memory:",
            ...[...snapshot.processes.items]
                .sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid)
                .slice(0, 5)
                .map(processText),
        );
    }
    return lines.join("\n");
}
