/**
 * Session-speed benchmark for CI: seeds a throwaway installation through the daemon's own API,
 * then times what makes a client wait — restart until ready, the first reads after it, the
 * desktop bootstrap, and opening a long session — and writes the medians as JSON.
 *
 * It runs `perf/serve.ts` in a child process, so every restart is a real process start over the
 * same data. Nothing outside the two temporary folders it creates is read or written.
 *
 * Env: PERF_OUT (results JSON, required), PERF_HEAVY (sessions with long histories, 12),
 * PERF_SENDS (messages each heavy session is sent, 3), PERF_LIGHT (sessions with no history, 300),
 * PERF_RESTARTS (3), PERF_REPEATS (warm reads per measurement, 7).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = required("PERF_OUT");
const heavy = Number(process.env.PERF_HEAVY ?? "12");
const sends = Number(process.env.PERF_SENDS ?? "3");
const light = Number(process.env.PERF_LIGHT ?? "300");
const restarts = Number(process.env.PERF_RESTARTS ?? "3");
const repeats = Number(process.env.PERF_REPEATS ?? "7");
const MODE = {
    effort: "medium",
    modelId: "anthropic/opus-5-5",
    permissionMode: "full_access",
    providerId: "claude",
    serviceTier: null,
};
// Every wait is bounded, so a build that hangs fails its own step instead of using up the job.
const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const root = await mkdtemp(join(tmpdir(), "happy-ci-bench-"));
const happyHome = join(root, "home");
const scratch = join(root, "scratch");
const projectPath = join(root, "project");
let child: ChildProcess | undefined;
let daemon: { socketPath: string; token: string } | undefined;

try {
    await start({ PERF_SYNTHETIC: "1", PERF_TEXT_CHUNK: "400", PERF_TEXT_DELAY_MS: "0" });
    const seeded = await seed();
    const samples = new Map<string, number[]>();
    const sample = (name: string, ms: number) => {
        const list = samples.get(name) ?? [];
        list.push(ms);
        samples.set(name, list);
    };
    for (let restart = 0; restart < restarts; restart += 1) {
        await shutdown();
        const spawned = performance.now();
        await start({});
        const ready = performance.now();
        sample("restartReadyMs", ready - spawned);
        // What a client reconnecting at once waits for: its bootstrap and the open session.
        const [bootstrap, messages] = await Promise.all([
            timed("/v0/bootstrap/desktop"),
            timed(`/v0/agents/${seeded.heavy[0]!}/messages?limit=100`),
        ]);
        sample("firstBootstrapAfterReadyMs", bootstrap);
        sample("firstMessagesAfterReadyMs", messages);
        // Give the work deferred past ready a moment, then measure the steady state.
        await sleep(3_000);
        for (let i = 0; i < repeats; i += 1) {
            sample("desktopBootstrapMs", await timed("/v0/bootstrap/desktop"));
            const agentId = seeded.heavy[i % seeded.heavy.length]!;
            const opened = performance.now();
            await Promise.all([
                timed(`/v0/agents/${agentId}/messages?limit=100`),
                timed(`/v0/agents/${agentId}/bootstrap`),
                timed(`/v0/agents/${agentId}/activity`),
                timed(`/v0/agents/${agentId}/question`),
            ]);
            sample("sessionOpenMs", performance.now() - opened);
        }
    }
    const metrics = Object.fromEntries(
        [...samples].map(([name, values]) => [name, Math.round(median(values) * 10) / 10]),
    );
    await writeFile(
        out,
        JSON.stringify({ at: new Date().toISOString(), seeded: seeded.counts, metrics }, null, 4),
    );
    console.log(JSON.stringify(metrics));
} finally {
    await shutdown().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
}

/** Sessions with long histories and many without any, in one project's root workspace. */
async function seed(): Promise<{ heavy: string[]; counts: Record<string, number> }> {
    await mkdir(projectPath, { recursive: true });
    const { project } = await call<{ project: { id: string } }>("POST", "/v0/projects", {
        path: projectPath,
    });
    for (let i = 0; ; i += 1) {
        const { project: current } = await call<{
            project: { initialization: { status: string } };
        }>("GET", `/v0/projects/${project.id}`);
        if (current.initialization.status === "ready") break;
        if (i > 600) throw new Error("The benchmark project never finished initializing.");
        await sleep(50);
    }
    const create = async (title: string) =>
        (
            await call<{ agent: { id: string } }>("POST", "/v0/agents", {
                title,
                workspaceId: project.id,
            })
        ).agent.id;
    const heavyIds: string[] = [];
    for (let i = 0; i < heavy; i += 1) heavyIds.push(await create(`Heavy ${String(i + 1)}`));
    await Promise.all(
        heavyIds.map(async (agentId) => {
            for (let i = 0; i < sends; i += 1) {
                await call("POST", `/v0/agents/${agentId}/send`, {
                    mode: MODE,
                    text: `Work through step ${String(i + 1)}.`,
                });
                await waitRunsDone(agentId, i + 1);
            }
        }),
    );
    for (let i = 0; i < light; i += 1) await create(`Light ${String(i + 1)}`);
    // How long a heavy session really is, so a change to the seeding shows up beside the timings.
    const page = await call<{ runs: { messages: unknown[] }[] }>(
        "GET",
        `/v0/agents/${heavyIds[0]!}/messages?limit=100`,
    );
    const pageKB = Math.round(JSON.stringify(page).length / 1024);
    const messages = page.runs.reduce((count, run) => count + run.messages.length, 0);
    return { heavy: heavyIds, counts: { heavy, sends, light, pageKB, messages } };
}

async function start(env: Record<string, string>): Promise<void> {
    await rm(join(scratch, "daemon.json"), { force: true });
    const spawned = spawn(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname, "serve.ts")],
        {
            cwd: join(import.meta.dirname, ".."),
            env: { ...process.env, ...env, PERF_HAPPY_HOME: happyHome, PERF_SCRATCH: scratch },
            stdio: ["ignore", "ignore", "inherit"],
        },
    );
    child = spawned;
    let exited = false;
    spawned.once("exit", () => (exited = true));
    const deadline = performance.now() + START_TIMEOUT_MS;
    const waiting = () => {
        if (exited) throw new Error("The benchmark daemon exited while starting.");
        if (performance.now() > deadline) {
            throw new Error("The benchmark daemon was not ready within two minutes.");
        }
    };
    for (;;) {
        waiting();
        const written = await readFile(join(scratch, "daemon.json"), "utf8").catch(() => undefined);
        if (written !== undefined) {
            const { socketPath, tokenPath } = JSON.parse(written) as {
                socketPath: string;
                tokenPath: string;
            };
            daemon = { socketPath, token: (await readFile(tokenPath, "utf8")).trim() };
            break;
        }
        await sleep(10);
    }
    for (;;) {
        waiting();
        const health = await call<{ ready?: boolean }>("GET", "/v0/health").catch(() => undefined);
        if (health?.ready === true) return;
        await sleep(10);
    }
}

async function shutdown(): Promise<void> {
    const running = child;
    if (running === undefined) return;
    child = undefined;
    daemon = undefined;
    if (running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise((resolve) => running.once("exit", resolve));
    running.kill("SIGINT");
    const kill = setTimeout(() => running.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
    await exited;
    clearTimeout(kill);
}

/** Wait until `count` runs of one agent have finished; a status read can precede the first. */
async function waitRunsDone(agentId: string, count: number): Promise<void> {
    for (let i = 0; i < 2_400; i += 1) {
        const page = await call<{ runs: { status: string }[] }>(
            "GET",
            `/v0/agents/${agentId}/messages?limit=100&omitToolData=true`,
        );
        if (page.runs.filter((run) => run.status !== "running").length >= count) return;
        await sleep(50);
    }
    throw new Error(`Agent ${agentId} never finished run ${String(count)}.`);
}

async function timed(path: string): Promise<number> {
    const started = performance.now();
    await call("GET", path, undefined, { "accept-encoding": "br, gzip" });
    return performance.now() - started;
}

function call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
): Promise<T> {
    const running = daemon;
    if (running === undefined) return Promise.reject(new Error("The daemon is not running."));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = request(
            {
                headers: {
                    ...headers,
                    authorization: `Bearer ${running.token}`,
                    ...(payload === undefined ? {} : { "content-type": "application/json" }),
                },
                method,
                path,
                socketPath: running.socketPath,
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    const status = res.statusCode ?? 0;
                    if (status >= 400) {
                        reject(new Error(`${method} ${path} answered ${String(status)}.`));
                        return;
                    }
                    // Timed reads may come back compressed; only their duration matters.
                    if (res.headers["content-encoding"] !== undefined) {
                        resolve(undefined as T);
                        return;
                    }
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve((text.length === 0 ? undefined : JSON.parse(text)) as T);
                });
            },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error(`${method} ${path} did not answer.`)));
        req.end(payload);
    });
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
    return value;
}
