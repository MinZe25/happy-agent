/**
 * A remote Happy Agent for the session gym: another gym daemon in its own folder, seeded once with
 * sessions that have histories and many that have none, onboarded the way a team remote is, and
 * reachable through `perf/latencyRelay.ts` at a network-like round trip. It writes
 * `<PERF_REMOTE_DIR>/remote.json` with the relay socket and the remote's token, which is what the
 * local daemon's `[connections.*]` entries and `PERF_REMOTE_CARRIER` need, then runs until SIGINT.
 *
 * Env: PERF_REMOTE_DIR (required), PERF_REMOTE_RTT_MS (60), PERF_HEAVY (8), PERF_SENDS (3),
 * PERF_LIGHT (60). PERF_REMOTE_SOURCE, a folder holding an installation's `agent.sqlite` and
 * `auto-agent.sqlite`, serves a fresh copy of that real-sized data on every start instead of
 * seeding.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";

const dir = required("PERF_REMOTE_DIR");
const roundTripMs = process.env.PERF_REMOTE_RTT_MS ?? "60";
const heavy = Number(process.env.PERF_HEAVY ?? "8");
const sends = Number(process.env.PERF_SENDS ?? "3");
const light = Number(process.env.PERF_LIGHT ?? "60");
const scratch = join(dir, "scratch");
const SHUTDOWN_TIMEOUT_MS = 10_000;
const carrier = join(dir, "carrier.sock");
const MODE = {
    effort: "medium",
    modelId: "anthropic/opus-5-5",
    permissionMode: "full_access",
    providerId: "claude",
    serviceTier: null,
};

await mkdir(scratch, { recursive: true });
await rm(join(scratch, "daemon.json"), { force: true });
const source = process.env.PERF_REMOTE_SOURCE;
if (source !== undefined) {
    const agentHome = join(dir, "home", "agent");
    await mkdir(agentHome, { recursive: true });
    for (const name of ["agent.sqlite", "auto-agent.sqlite"]) {
        for (const suffix of ["", "-wal", "-shm"])
            await rm(join(agentHome, name + suffix), { force: true });
        // A copy-on-write clone where the file system has them, so the copy is instant.
        await copyFile(join(source, name), join(agentHome, name), constants.COPYFILE_FICLONE);
    }
}
const children: ChildProcess[] = [];
const gym = join(import.meta.dirname, "..");
const daemon = spawn(process.execPath, ["--import", "tsx", join(gym, "perf", "serve.ts")], {
    cwd: gym,
    env: {
        ...process.env,
        PERF_HAPPY_HOME: join(dir, "home"),
        PERF_SCRATCH: scratch,
        PERF_SYNTHETIC: "1",
        PERF_TEXT_CHUNK: "400",
        PERF_TEXT_DELAY_MS: "0",
    },
    stdio: ["ignore", "inherit", "inherit"],
});
children.push(daemon);
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

let socketPath = "";
let token = "";
try {
    await serve();
} finally {
    // Whatever failed, no daemon is left holding the data's lock.
    await stop();
}

async function serve(): Promise<void> {
    let started: { socketPath: string; tokenPath: string } | undefined;
    for (let i = 0; started === undefined; i += 1) {
        if (daemon.exitCode !== null || daemon.signalCode !== null || i > 12_000)
            throw new Error("The remote gym daemon did not start.");
        const written = await readFile(join(scratch, "daemon.json"), "utf8").catch(() => undefined);
        if (written !== undefined) started = JSON.parse(written) as typeof started;
        else await sleep(10);
    }
    socketPath = started.socketPath;
    token = (await readFile(started.tokenPath, "utf8")).trim();

    const seededMarker = join(dir, "seeded");
    if (
        source === undefined &&
        (await readFile(seededMarker, "utf8").catch(() => undefined)) === undefined
    ) {
        await seed();
        await writeFile(seededMarker, "seeded\n");
    }
    await call("POST", "/v0/onboarding/complete");

    const relay = spawn(
        process.execPath,
        ["--import", "tsx", join(gym, "perf", "latencyRelay.ts"), carrier, socketPath, roundTripMs],
        { cwd: gym, stdio: ["ignore", "inherit", "inherit"] },
    );
    children.push(relay);
    await writeFile(join(dir, "remote.json"), JSON.stringify({ carrier, token, roundTripMs }));
    console.log(`remote gym ready: ${carrier} (${roundTripMs} ms round trip)`);
    await new Promise((resolve) => daemon.once("exit", resolve));
}

/** Asks every child to stop, and kills one still running after SHUTDOWN_TIMEOUT_MS. */
async function stop(): Promise<void> {
    await Promise.all(
        children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise((resolve) => child.once("exit", resolve));
            child.kill("SIGINT");
            const timer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
            await exited;
            clearTimeout(timer);
        }),
    );
}

async function seed(): Promise<void> {
    const projectPath = join(dir, "project");
    await mkdir(projectPath, { recursive: true });
    const { project } = await call<{ project: { id: string } }>("POST", "/v0/projects", {
        path: projectPath,
    });
    for (let i = 0; ; i += 1) {
        const { project: current } = await call<{
            project: { initialization: { status: string } };
        }>("GET", `/v0/projects/${project.id}`);
        if (current.initialization.status === "ready") break;
        if (i > 600) throw new Error("The remote project never finished initializing.");
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
    for (let i = 0; i < heavy; i += 1) heavyIds.push(await create(`Remote ${String(i + 1)}`));
    await Promise.all(
        heavyIds.map(async (agentId) => {
            for (let i = 0; i < sends; i += 1) {
                await call("POST", `/v0/agents/${agentId}/send`, {
                    mode: MODE,
                    text: `Work through step ${String(i + 1)}.`,
                });
                for (let poll = 0; ; poll += 1) {
                    const page = await call<{ runs: { status: string }[] }>(
                        "GET",
                        `/v0/agents/${agentId}/messages?limit=100&omitToolData=true`,
                    );
                    if (page.runs.filter((run) => run.status !== "running").length > i) break;
                    if (poll > 2_400) throw new Error(`Remote agent ${agentId} never finished.`);
                    await sleep(50);
                }
            }
        }),
    );
    for (let i = 0; i < light; i += 1) await create(`Remote light ${String(i + 1)}`);
}

function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = request(
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(payload === undefined ? {} : { "content-type": "application/json" }),
                },
                method,
                path,
                socketPath,
                timeout: 60_000,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((res.statusCode ?? 0) >= 400) {
                        reject(
                            new Error(
                                `${method} ${path} answered ${String(res.statusCode)}: ${text}`,
                            ),
                        );
                        return;
                    }
                    resolve((text.length === 0 ? undefined : JSON.parse(text)) as T);
                });
            },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error(`${method} ${path} did not answer.`)));
        req.end(payload);
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
    return value;
}
