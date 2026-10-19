import type { SystemMonitorGpu } from "@slopus/happy-agent-client";
import { numberOrNull, percent } from "./parseProcess.js";

/** nvidia-smi --query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw --format=csv,noheader,nounits */
export function parseNvidia(text: string): SystemMonitorGpu[] {
    return text
        .trim()
        .split("\n")
        .flatMap((line) => {
            const fields = line
                .match(/(?:"(?:[^"]|"")*"|[^,])+/g)
                ?.map((v) => v.trim().replace(/^"|"$/g, "").replaceAll('""', '"'));
            if (fields === undefined || fields.length !== 6 || fields[0] === "") return [];
            const usage = numberOrNull(fields[1]),
                total = numberOrNull(fields[2]),
                used = numberOrNull(fields[3]);
            return [
                {
                    name: fields[0]!,
                    vendor: "nvidia",
                    usagePercent: usage === null ? null : percent(usage),
                    memoryTotalBytes: total === null ? null : total * 1024 ** 2,
                    memoryUsedBytes: used === null ? null : used * 1024 ** 2,
                    temperatureCelsius: numberOrNull(fields[4]),
                    powerWatts: numberOrNull(fields[5]),
                },
            ];
        });
}
