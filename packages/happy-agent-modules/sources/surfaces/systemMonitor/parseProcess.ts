import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    systemMonitorProcessSchema,
    type SystemMonitorProcess,
    type SystemMonitorProcesses,
} from "@slopus/happy-agent-client";

export const rawProcessSchema = Type.Object({
    ...systemMonitorProcessSchema.properties,
    cpuTime: Type.Number({ minimum: 0 }),
    startIdentity: Type.String(),
});
export type RawProcess = Static<typeof rawProcessSchema>;
const nonnegative = Type.Number({ minimum: 0 });
export function numberOrNull(value: string | number | undefined): number | null {
    if (value === undefined || value === "") return null;
    const result = Number(value);
    return Value.Check(nonnegative, result) ? result : null;
}
export const percent = (value: number) => Math.max(0, Math.min(100, value));
/** Normalize the documented procfs/ps state letters without exposing OS-specific codes. */
export function processState(value: string): SystemMonitorProcess["state"] {
    switch (value[0]?.toUpperCase()) {
        case "R":
            return "running";
        case "S":
        case "D":
        case "U":
            return "sleeping";
        case "T":
            return "stopped";
        case "Z":
            return "zombie";
        case "I":
            return "idle";
        default:
            return "other";
    }
}
/** Keep idle memory-heavy processes as well as CPU-heavy ones, with a stable tie-break. */
export function processLeaders(
    items: SystemMonitorProcess[],
    total: number,
): SystemMonitorProcesses {
    const byCpu = (a: SystemMonitorProcess, b: SystemMonitorProcess) =>
        (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) ||
        b.memoryBytes - a.memoryBytes ||
        a.pid - b.pid;
    const cpu = [...items].sort(byCpu).slice(0, 50);
    const memory = [...items]
        .sort((a, b) => b.memoryBytes - a.memoryBytes || byCpu(a, b))
        .slice(0, 50);
    const selected = new Map([...cpu, ...memory].map((item) => [item.pid, item]));
    return {
        total,
        threads:
            items.length === total && items.every((item) => item.threads !== null)
                ? items.reduce((sum, item) => sum + (item.threads ?? 0), 0)
                : null,
        items: [...selected.values()].sort(byCpu),
    };
}
