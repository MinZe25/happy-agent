/**
 * Session-speed perf daemon.
 *
 * Starts the real Happy Agent daemon in this process over a copied, sanitized production
 * database (`PERF_HAPPY_HOME`), with the gym's two substitutions: inference is scripted and the
 * machine is just-bash. The scripted model streams realistically: reasoning, many small text
 * deltas at model-like cadence, and shell tool calls with sizable output, over several inferences
 * per run, so the daemon and every connected client see production-shaped event traffic.
 *
 * PERF_REMOTE_CARRIER, a Unix socket path, replaces the Tailcat carrier to every configured remote
 * connection with that socket (`perf/latencyRelay.ts` in front of another gym daemon), so remotes
 * are measured offline while the proxy, its pool, and both daemons' APIs stay the real ones.
 */
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";

import type { AgentModel } from "@slopus/happy-agent-base";
import { startHappyAgentDaemon } from "@slopus/happy-agent";
import { TailcatModule } from "@slopus/happy-agent-modules";

import { createGymCompute } from "../sources/createGymCompute.js";
import {
    createScriptedInference,
    type GymBlock,
    type GymInferenceRequest,
    type GymTurn,
} from "../sources/scriptedInference.js";

const happyHome = required("PERF_HAPPY_HOME");
const scratch = required("PERF_SCRATCH");
const textChunk = Number(process.env.PERF_TEXT_CHUNK ?? "4");
const textDelayMs = Number(process.env.PERF_TEXT_DELAY_MS ?? "12");
const toolRounds = Number(process.env.PERF_TOOL_ROUNDS ?? "6");

const remoteCarrier = process.env.PERF_REMOTE_CARRIER;
if (remoteCarrier !== undefined) {
    TailcatModule.prototype.openRemote = () =>
        ({
            connect: () =>
                new Promise<Socket>((resolve, reject) => {
                    const socket = connect(remoteCarrier);
                    socket.once("connect", () => resolve(socket));
                    socket.once("error", reject);
                }),
            close: async () => undefined,
        }) as never;
}

/** The production provider catalog, so existing agents resolve their real selection. */
const CATALOG: Record<string, readonly string[]> = {
    claude: [
        "anthropic/opus-5-5",
        "anthropic/sonnet-5-5",
        "anthropic/haiku-5-5",
        "anthropic/fable-5-1",
    ],
    claude_extra: ["anthropic/opus-5-5", "anthropic/sonnet-5-5"],
    codex_pool: ["openai/gpt-5.6-sol", "openai/gpt-6.1-sol", "openai/gpt-6-sol"],
    grok: ["xai/grok-4.7"],
};
// An installation's own provider IDs, as JSON `{ "<providerId>": ["<modelId>", ...] }`.
Object.assign(CATALOG, JSON.parse(process.env.PERF_EXTRA_PROVIDERS ?? "{}") as Record<string, readonly string[]>);
const models: AgentModel[] = Object.entries(CATALOG).flatMap(([providerId, ids]) =>
    ids.map((id) => ({
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id,
        name: id,
        providerId,
    })),
);

const PROSE =
    "I looked at the session list projection and the history read path. The slow part is the " +
    "full transcript projection that runs on every delta, which rebuilds each row and re-parses " +
    "markdown for messages that did not change. Here is the plan:\n\n" +
    "1. Keep settled rows by identity.\n2. Coalesce deltas per animation frame.\n" +
    "3. Serve the newest page without tool payloads.\n\n```ts\nconst rows = reuse(previous, next);\n" +
    "for (const row of rows) render(row);\n```\n\nThat should remove most of the work. ";

/**
 * A recorded run to replay for one agent, written by the gym to `<scratch>/replay/<agentId>.json`.
 * Each inference is one recorded assistant message; a `command` block becomes one shell call.
 */
interface ReplayPlan {
    readonly inferences: readonly {
        readonly blocks: readonly (
            | { readonly type: "reasoning" | "text"; readonly text: string }
            | { readonly type: "command"; readonly command: string }
        )[];
    }[];
    readonly chunk?: number;
    readonly delayMs?: number;
}
const replays = new Map<string, { plan: ReplayPlan; next: number; loadedAt: number }>();

function replayTurn(
    request: GymInferenceRequest,
    shellName: string | undefined,
): GymTurn | undefined {
    const path = join(scratch, "replay", `${request.sessionId}.json`);
    let mtimeMs: number;
    try {
        mtimeMs = statSync(path).mtimeMs;
    } catch {
        return undefined;
    }
    let state = replays.get(request.sessionId);
    if (state === undefined || state.loadedAt !== mtimeMs) {
        state = {
            loadedAt: mtimeMs,
            next: 0,
            plan: JSON.parse(readFileSync(path, "utf8")) as ReplayPlan,
        };
        replays.set(request.sessionId, state);
    }
    const inference = state.plan.inferences[state.next];
    state.next += 1;
    const blocks: GymBlock[] =
        inference === undefined
            ? [{ text: "Replay finished.", type: "text" }]
            : inference.blocks.flatMap((block): GymBlock[] => {
                  if (block.type !== "command") return [block];
                  if (shellName === undefined) return [];
                  return [
                      {
                          arguments: shellArguments(shellName, block.command),
                          name: shellName,
                          type: "tool_call",
                      },
                  ];
              });
    return {
        content: blocks,
        textDeltaChunkSize: state.plan.chunk ?? 10,
        textDeltaDelayMs: state.plan.delayMs ?? 25,
        usage: { cacheRead: 120_000, cacheWrite: 2_000, input: 3_000, output: 900 } as never,
    };
}

function shellArguments(name: string, command: string): unknown {
    if (name === "Bash") return { command, description: "Replay recorded output" };
    if (name === "exec_command") return { cmd: command };
    return { command };
}

function turnFor(request: GymInferenceRequest): GymTurn {
    // Detached naming and other side requests get a short answer immediately.
    if (request.tools.length === 0) return { content: [{ text: "Perf session", type: "text" }] };
    const shell = request.tools.find((tool) =>
        /^(bash|exec_command|shell|run_terminal_command)$/i.test(tool.name),
    );
    const replay = replayTurn(request, shell?.name);
    if (replay !== undefined) return replay;
    // Runs restored from the copied installation finish at once unless synthetic load is asked for.
    if (process.env.PERF_SYNTHETIC !== "1") return { content: [{ text: "Done.", type: "text" }] };
    const round = request.messages.filter((message) => message.role === "tool").length;
    const blocks: GymBlock[] = [
        { text: "Thinking about which files matter here. ".repeat(12), type: "reasoning" },
        { text: PROSE.repeat(round + 1 >= toolRounds ? 4 : 1), type: "text" },
    ];
    if (shell !== undefined && round < toolRounds) {
        const command = `seq 1 ${String(400 + round * 300)} | sed 's/^/line of realistic tool output /'`;
        blocks.push({
            arguments: shellArguments(shell.name, command),
            name: shell.name,
            type: "tool_call",
        });
    }
    return {
        content: blocks,
        textDeltaChunkSize: textChunk,
        textDeltaDelayMs: textDelayMs,
        usage: { cacheRead: 120_000, cacheWrite: 2_000, input: 3_000, output: 900 } as never,
    };
}

/** Per-statement SQLite timing, aggregated by normalized SQL and dumped on SIGUSR1. */
const sqlStats = new Map<string, { calls: number; ms: number; rows: number }>();
if (process.env.PERF_SQL_STATS === "1") {
    const libsqlPath = process.env.PERF_LIBSQL_PATH;
    if (libsqlPath === undefined) throw new Error("PERF_LIBSQL_PATH is required for SQL stats.");
    const libsql = createRequire(libsqlPath)(libsqlPath) as {
        prototype: { prepare(sql: string): { __sql?: string } };
    };
    const prepare = libsql.prototype.prepare;
    let statementPrototype: Record<string, (...args: unknown[]) => unknown> | undefined;
    libsql.prototype.prepare = function (this: unknown, sql: string) {
        const started = performance.now();
        const statement = prepare.call(this, sql);
        record(`PREPARE ${sql}`, performance.now() - started, 0);
        statement.__sql = sql;
        if (statementPrototype === undefined) {
            statementPrototype = Object.getPrototypeOf(statement) as Record<
                string,
                (...args: unknown[]) => unknown
            >;
            for (const method of ["all", "get", "run"]) {
                const original = statementPrototype[method]!;
                statementPrototype[method] = function (this: { __sql?: string }, ...args) {
                    const began = performance.now();
                    const result = original.apply(this, args);
                    const sql = this.__sql ?? "?";
                    const shaped =
                        sql.includes("substr(key") && Array.isArray(args[0])
                            ? `${sql} -- ${String((args[0] as unknown[])[1]).replace(/[a-z0-9]{20,}/g, "*")}`
                            : sql;
                    record(
                        shaped,
                        performance.now() - began,
                        Array.isArray(result) ? result.length : 1,
                    );
                    return result;
                };
            }
        }
        return statement;
    };
    process.on("SIGUSR1", () => {
        const rows = [...sqlStats]
            .sort((a, b) => b[1].ms - a[1].ms)
            .slice(0, 60)
            .map(
                ([sql, stat]) =>
                    `${stat.ms.toFixed(0).padStart(8)}ms ${String(stat.calls).padStart(7)}x ${String(stat.rows).padStart(8)}rows  ${sql.slice(0, 400)}`,
            );
        void writeFile(
            join(scratch, `sql-stats-${String(Date.now())}.txt`),
            rows.join("\n") + "\n",
        ).then(() => console.log("sql stats written"));
        sqlStats.clear();
    });
}
function record(sql: string, ms: number, rows: number): void {
    const key = sql.replace(/\s+/g, " ").trim();
    const stat = sqlStats.get(key) ?? { calls: 0, ms: 0, rows: 0 };
    stat.calls += 1;
    stat.ms += ms;
    stat.rows += rows;
    sqlStats.set(key, stat);
}

// PERF_HTTP_SLOW_MS logs responses whose body took that long to flush after their headers.
const httpSlowMs = Number(process.env.PERF_HTTP_SLOW_MS ?? "0");
if (httpSlowMs > 0) {
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const writeHead = ServerResponse.prototype.writeHead;
    ServerResponse.prototype.writeHead = function (this: ServerResponse, ...args: unknown[]) {
        const headersAt = performance.now();
        loop.reset();
        this.once("finish", () => {
            const flushMs = performance.now() - headersAt;
            if (flushMs < httpSlowMs) return;
            const length = String(this.getHeader("content-length") ?? "?");
            console.log(
                `HTTPSLOW ${this.req.url ?? "?"} flush ${flushMs.toFixed(0)}ms bytes ${length} loopMax ${(loop.max / 1e6).toFixed(0)}ms loopMean ${(loop.mean / 1e6).toFixed(1)}ms`,
            );
        });
        return writeHead.apply(this, args as never);
    } as never;
}

const scripted = createScriptedInference({
    inference: turnFor,
    models,
    providerIds: Object.keys(CATALOG),
});

await mkdir(join(scratch, "projects"), { recursive: true });
await mkdir(join(scratch, "workspaces"), { recursive: true });
const gymCompute = createGymCompute();
const started = performance.now();
const daemon = await startHappyAgentDaemon({
    // The copied installation names folders that only exist on the real machine; the emulated
    // machine gets an empty one wherever an agent works.
    compute: async (ctx, config) => {
        await mkdir(config.cwd, { recursive: true });
        return await gymCompute(ctx, config);
    },
    environment: {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CODEX_HOME: join(scratch, "credentials", "codex"),
        GROK_HOME: join(scratch, "credentials", "grok"),
        HAPPY_AGENT_PROJECTS_DIRECTORY: join(scratch, "projects"),
        HAPPY_AGENT_WORKSPACES_DIRECTORY: join(scratch, "workspaces"),
        HAPPY_HOME_DIR: join(scratch, "credentials", "happy"),
        HOME: join(scratch, "home"),
        OPENAI_API_KEY: undefined,
        XAI_API_KEY: undefined,
    },
    happyHome,
    inference: { models: scripted.models, providers: scripted.createProviders() },
    version: process.env.PERF_VERSION ?? "0.4.101",
});
const readyMs = performance.now() - started;
await writeFile(
    join(scratch, "daemon.json"),
    JSON.stringify({ readyMs, socketPath: daemon.socketPath, tokenPath: daemon.tokenPath }),
);
console.log(`perf daemon ready in ${readyMs.toFixed(0)} ms at ${daemon.socketPath}`);
if (process.env.PERF_EXIT_AFTER_READY === "1") {
    const closing = performance.now();
    await daemon.close("requested");
    console.log(`perf daemon closed in ${(performance.now() - closing).toFixed(0)} ms`);
    process.exit(0);
}

// SIGUSR2 toggles a CPU profile written to the scratch folder.
const inspector = new Session();
inspector.connect();
let profiling = false;
process.on("SIGUSR2", () => {
    if (!profiling) {
        profiling = true;
        inspector.post("Profiler.enable", () =>
            inspector.post("Profiler.setSamplingInterval", { interval: 200 }, () =>
                inspector.post("Profiler.start", () => console.log("profile started")),
            ),
        );
        return;
    }
    profiling = false;
    inspector.post("Profiler.stop", (error, result) => {
        if (error !== null) return console.error(error);
        const path = join(scratch, `daemon-${String(Date.now())}.cpuprofile`);
        void writeFile(path, JSON.stringify(result.profile)).then(() =>
            console.log(`profile written ${path}`),
        );
    });
});

// PERF_PROFILE_AFTER_READY_MS profiles the daemon for that long from the moment it is ready.
const afterReadyMs = Number(process.env.PERF_PROFILE_AFTER_READY_MS ?? "0");
if (afterReadyMs > 0) {
    process.emit("SIGUSR2" as never);
    setTimeout(() => process.emit("SIGUSR2" as never), afterReadyMs);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        void daemon.close("sigint").finally(() => process.exit(0));
    });
}
// Like `happy-agent run`, exit once the daemon closes, including after an API shutdown.
await daemon.closed.finally(() => process.exit(0));

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
    return value;
}
