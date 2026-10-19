/**
 * Compares two `ciBench.ts` results and flags what got slower. It never fails: a shared runner's
 * timings are too noisy to block a merge on, so a regression is reported as a warning annotation
 * and in the job summary for a person to judge. A missing or unreadable result is reported, too.
 *
 * Usage: node --import tsx perf/ciCompare.ts <base.json> <head.json>
 * Env: PERF_REGRESSION_PCT (20) and PERF_REGRESSION_MIN_MS (5) — a metric is flagged only when it
 * is slower by both.
 */
import { appendFile, readFile } from "node:fs/promises";

interface BenchResult {
    readonly seeded: Record<string, number>;
    readonly metrics: Record<string, number>;
}

const [basePath, headPath] = process.argv.slice(2);
if (basePath === undefined || headPath === undefined) {
    throw new Error("Usage: ciCompare.ts <base.json> <head.json>");
}
const pct = Number(process.env.PERF_REGRESSION_PCT ?? "20");
const minMs = Number(process.env.PERF_REGRESSION_MIN_MS ?? "5");
const head = await readResult(headPath);
// A base the benchmark cannot run against (one older than the gym it uses, say) has no result.
const base = (await readResult(basePath)) ?? { seeded: {}, metrics: {} };

const rows: string[] = [];
const regressions: string[] = [];
for (const [name, after] of Object.entries(head?.metrics ?? {})) {
    const before = base.metrics[name];
    if (before === undefined) {
        rows.push(`| ${name} | – | ${String(after)} | new |`);
        continue;
    }
    const change = before === 0 ? 0 : ((after - before) / before) * 100;
    const slower = after - before >= minMs && change >= pct;
    if (slower) regressions.push(name);
    rows.push(
        `| ${name} | ${String(before)} | ${String(after)} | ${change >= 0 ? "+" : ""}${change.toFixed(0)}%${slower ? " ⚠️" : ""} |`,
    );
}

const summary = [
    "### Session speed benchmark",
    "",
    ...(head === undefined
        ? ["No result for this change: its build or benchmark failed, see the step before."]
        : [
              `Medians in ms, base → this change. Flagged when slower by ≥ ${String(pct)}% and ≥ ${String(minMs)} ms.`,
              "",
              "| metric | base | head | change |",
              "| --- | ---: | ---: | ---: |",
              ...rows,
              "",
              `Seeded: ${JSON.stringify(head.seeded)}`,
          ]),
    "",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary).catch((error: unknown) =>
        console.log(`The job summary could not be written: ${String(error)}`),
    );
}
for (const name of regressions) {
    console.log(
        `::warning title=Session speed regression::${name} ${String(base.metrics[name])} → ${String(head?.metrics[name])} ms`,
    );
}

async function readResult(path: string): Promise<BenchResult | undefined> {
    try {
        const result = JSON.parse(await readFile(path, "utf8")) as Partial<BenchResult> | null;
        if (typeof result?.metrics !== "object" || result.metrics === null) return undefined;
        return { seeded: result.seeded ?? {}, metrics: result.metrics };
    } catch {
        return undefined;
    }
}
