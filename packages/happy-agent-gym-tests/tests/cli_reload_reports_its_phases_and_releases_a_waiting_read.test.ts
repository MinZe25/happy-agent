import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join, resolve } from "node:path";

import { HappyAgentClient } from "@slopus/happy-agent-client";
import { createGymHome, createUnixSocketFetch, type GymHome } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `happy-agent reload` driven as a person or an agent runs it: a real CLI process against a real
 * daemon process, in a throwaway Happy home, with inference scripted over the daemon's gym HTTP
 * seam. Nothing here can reach the installation of whoever runs the test: every process gets its
 * own HAPPY_HOME_DIR and HOME, and cleanup stops only the daemon named by that home's PID file.
 *
 * The executable is `HAPPY_AGENT_RELOAD_GYM_BINARY` when set, else the locally compiled binary
 * (`pnpm --filter @slopus/happy-agent build:bun`) when present, else the built CLI under Node.
 */
const PACKAGE = resolve(import.meta.dirname, "../../happy-agent");
const COMPILED = join(PACKAGE, "dist", "bin", `happy-agent-${process.platform}-${process.arch}`);
const COMMAND: readonly string[] =
    process.env.HAPPY_AGENT_RELOAD_GYM_BINARY !== undefined
        ? [resolve(process.env.HAPPY_AGENT_RELOAD_GYM_BINARY)]
        : existsSync(COMPILED)
          ? [COMPILED]
          : [process.execPath, join(PACKAGE, "dist", "cli.js")];

const CLAUDE_MODEL = "anthropic/opus-5";
const RESTART_NOTICE = "Happy Agent is restarting";

interface ReloadStatus {
    readonly operationId: string;
    readonly pid: number;
    readonly startedAt: number;
    readonly updatedAt: number;
    readonly phase: "draining" | "stopping" | "starting" | "done" | "failed";
    readonly phaseStartedAt: number;
    readonly waitingFor?: readonly unknown[];
    readonly finishedAt?: number;
    readonly failedAt?: string;
    readonly message?: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
}, 60_000);

/** One isolated installation with a scripted model and the CLI pointed at it. */
async function installation(options: { readonly agentTurns?: AgentScript } = {}) {
    const home = await createGymHome();
    cleanups.push(async () => await home.remove());
    // A Claude model, so the agent gets Claude's own BashOutput; the gym seam serves it.
    const claudeConfig = join(home.root, "claude");
    await mkdir(claudeConfig);
    await mkdir(join(home.root, "home"));
    await writeFile(
        join(home.publicHomePath, "Config", "happy.toml"),
        [
            "[defaults]",
            'permission_mode = "full_access"',
            "",
            "[providers]",
            "default_enable = false",
            "",
            "[providers.claude]",
            "enabled = true",
            `config_dir = ${JSON.stringify(claudeConfig)}`,
            `include_models = [${JSON.stringify(CLAUDE_MODEL)}]`,
            "",
        ].join("\n"),
    );
    const inference = await inferenceServer(options.agentTurns ?? (() => text("Done.")));
    cleanups.push(
        async () => await new Promise<void>((done) => inference.server.close(() => done())),
    );
    const environment = isolatedEnvironment(home, inference.url, inference.token);
    const cli = (args: readonly string[]) => runCli(args, environment);
    // Stop exactly this home's daemon, whatever state a failed scenario left it in.
    cleanups.push(async () => {
        await cli(["kill"]);
    });
    const statusPath = join(home.happyHome, "agent", "reload.json");
    const readStatus = async (): Promise<ReloadStatus | undefined> => {
        try {
            return JSON.parse(await readFile(statusPath, "utf8")) as ReloadStatus;
        } catch {
            return undefined;
        }
    };
    const connect = async (): Promise<HappyAgentClient> => {
        const token = (await readFile(join(home.happyHome, "agent", "token"), "utf8")).trim();
        const client = new HappyAgentClient({
            endpoint: "http://happy-agent.reload-gym",
            fetch: createUnixSocketFetch(join(home.happyHome, "agent", "server.sock")),
            token,
        });
        await until(async () => ((await client.getHealth()).ready ? true : undefined), "ready");
        return client;
    };
    return { cli, connect, environment, home, inference, readStatus, statusPath };
}

describe.skipIf(process.platform === "win32")("happy-agent reload from the CLI", () => {
    it("releases a waiting BashOutput, reports every phase, and comes back with the conversation", async () => {
        const world = await installation({
            agentTurns: (body) => {
                const seen = JSON.stringify(body.context.messages);
                if (!seen.includes("still running as background shell")) {
                    return toolCall("Bash", "startbench", {
                        command:
                            "while [ ! -e go ]; do sleep 0.05; done; printf 'tick\\n'; : > ticked; sleep 60",
                        run_in_background: true,
                    });
                }
                if (!seen.includes(`Background shell`)) {
                    // The read waits ten minutes. Beside it, an ordinary command the test holds keeps
                    // the batch, and so the drain, open long enough to watch every phase.
                    const bashId = /background shell (\d+)/u.exec(seen)?.[1];
                    return toolCalls([
                        toolCallBlock("BashOutput", "waitbench", {
                            bash_id: bashId,
                            block: true,
                            timeout: 600_000,
                        }),
                        toolCallBlock("Bash", "holddrain", {
                            command: "while [ ! -e hold-released ]; do sleep 0.05; done; echo held",
                        }),
                    ]);
                }
                return text("The benchmark is still running.");
            },
        });
        expect((await world.cli(["start"])).code).toBe(0);
        const client = await world.connect();
        const { agentId, mode } = await openAgent(client, world.home);

        await client.sendMessage(agentId, { mode, text: "Start the benchmark and wait for it." });
        await until(
            async () =>
                toolCallStatus(await client.getMessages(agentId), "BashOutput") === "running"
                    ? true
                    : undefined,
            "the BashOutput read to be waiting",
        );
        // The command prints only once the read is already waiting on it.
        await writeFile(join(world.home.workspacePath, "go"), "");
        await until(
            async () =>
                (await exists(join(world.home.workspacePath, "ticked"))) ? true : undefined,
            "the benchmark to print",
        );

        const observed: ReloadStatus[] = [];
        const reloadStartedAt = Date.now();
        const reload = world.cli(["reload"]);
        const watching = watchStatus(world.readStatus, observed, reload);
        // While the drain is still held open by the other call, the read has already answered
        // and its result is committed on the old daemon, which still serves reads.
        const draining = await until(async () => {
            const status = await world.readStatus();
            return status?.phase === "draining" &&
                JSON.stringify(status.waitingFor).includes('"stage":"tools"') &&
                toolCallStatus(await client.getMessages(agentId), "BashOutput") === "completed"
                ? status
                : undefined;
        }, "the drain to answer the waiting read");
        expect(Date.now() - reloadStartedAt).toBeLessThan(10_000);
        expect(JSON.stringify(await client.getMessages(agentId))).toContain(RESTART_NOTICE);
        await writeFile(join(world.home.workspacePath, "hold-released"), "");
        const result = await reload;
        await watching;
        expect(result.code, result.output).toBe(0);
        expect(Date.now() - reloadStartedAt).toBeLessThan(60_000);

        // One operation, from draining through done, with time only moving forward.
        const final = await world.readStatus();
        expect(final).toMatchObject({ phase: "done", finishedAt: expect.any(Number) });
        const ours = observed.filter((status) => status.operationId === final?.operationId);
        expect(ours.length).toBe(observed.length);
        expect(phasesInOrder(ours)).toEqual(["draining", "stopping", "starting", "done"]);
        expect(new Set(ours.map((status) => status.startedAt)).size).toBe(1);
        for (let index = 1; index < ours.length; index += 1) {
            expect(ours[index]!.updatedAt).toBeGreaterThanOrEqual(ours[index - 1]!.updatedAt);
        }
        expect(final!.startedAt).toBe(draining.startedAt);

        // The new daemon is ready, the read's result was committed with the restart said, and
        // the conversation continued on the new daemon from exactly there.
        const next = await world.connect();
        const history = await until(async () => {
            const messages = await next.getMessages(agentId);
            return JSON.stringify(messages).includes("The benchmark is still running.")
                ? messages
                : undefined;
        }, "the conversation to continue after the reload");
        expect(toolCallStatus(history, "BashOutput")).toBe("completed");
        const serialized = JSON.stringify(history);
        expect(serialized).toContain(RESTART_NOTICE);
        expect(serialized).toContain("tick");
        expect(history.runs.at(-1)).toMatchObject({ status: "completed" });
        const lastAgentRequest = world.inference.agentRequests.at(-1);
        expect(JSON.stringify(lastAgentRequest)).toContain(RESTART_NOTICE);
    }, 180_000);

    it("reports a detached reload's phases and where a failed reload stopped", async () => {
        const world = await installation();
        expect((await world.cli(["start"])).code).toBe(0);
        await world.connect();

        const detached = await world.cli(["reload", "--detach"]);
        expect(detached.code, detached.output).toBe(0);
        const done = await until(async () => {
            const status = await world.readStatus();
            return status?.phase === "done" ? status : undefined;
        }, "the detached reload to finish");
        expect(done).toMatchObject({
            finishedAt: expect.any(Number),
            operationId: expect.any(String),
        });
        await world.connect();
        const log = await readFile(join(world.home.happyHome, "agent", "reload.log"), "utf8");
        expect(log).toContain(
            `reload:phase phase=draining elapsedMs=0 operationId=${done.operationId}`,
        );
        expect(log).toMatch(
            /reload:phase phase=stopping previous=draining previousDurationMs=\d+/u,
        );
        expect(log).toMatch(
            /reload:phase phase=starting previous=stopping previousDurationMs=\d+/u,
        );
        expect(log).toMatch(/reload:phase phase=done previous=starting previousDurationMs=\d+/u);
        expect(log).toMatch(/reload:finish durationMs=\d+/u);

        // A configuration the replacement cannot load fails the reload after the old daemon
        // stopped, and the status says so rather than staying on "starting".
        await writeFile(join(world.home.publicHomePath, "Config", "happy.toml"), "[providers\n");
        const failed = await world.cli(["reload"]);
        expect(failed.code).not.toBe(0);
        const status = await world.readStatus();
        expect(status).toMatchObject({
            failedAt: "starting",
            finishedAt: expect.any(Number),
            message: expect.any(String),
            phase: "failed",
        });
        expect(status!.operationId).not.toBe(done.operationId);
    }, 180_000);
});

// --- Scripted inference over the daemon's gym HTTP seam ------------------------------------

interface InferenceBody {
    readonly context: { readonly messages: unknown[]; readonly tools?: unknown[] };
}
type AgentScript = (body: InferenceBody) => unknown;

async function inferenceServer(agentTurns: AgentScript) {
    const token = randomBytes(24).toString("hex");
    const agentRequests: InferenceBody[] = [];
    const server: Server = createServer((request, response) => {
        void (async () => {
            if (request.headers.authorization !== `Bearer ${token}`) {
                response.writeHead(401).end();
                return;
            }
            const body = JSON.parse(await readBody(request)) as InferenceBody;
            // Title requests offer no tools; only the conversation's own turns are scripted.
            const reply =
                (body.context.tools?.length ?? 0) === 0
                    ? text("<title>Reload gym</title>")
                    : (agentRequests.push(body), agentTurns(body));
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(reply));
        })().catch((error: unknown) => {
            response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No inference port.");
    return {
        agentRequests,
        server,
        token,
        url: `http://127.0.0.1:${String(address.port)}/inference`,
    };
}

function text(value: string) {
    return { content: [{ text: value, type: "text" }], stopReason: "stop" };
}

function toolCall(name: string, callId: string, args: Record<string, unknown>) {
    return toolCalls([toolCallBlock(name, callId, args)]);
}

function toolCalls(blocks: readonly unknown[]) {
    return { content: blocks };
}

function toolCallBlock(name: string, callId: string, args: Record<string, unknown>) {
    return { arguments: args, callId, name, type: "tool_call" };
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString("utf8");
}

// --- The CLI, isolated ----------------------------------------------------------------------

function isolatedEnvironment(home: GymHome, url: string, token: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        // Nothing that names another installation or a real account reaches the CLI.
        if (/^(HAPPY_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|XAI_|GROK_)/u.test(key)) continue;
        environment[key] = value;
    }
    return {
        ...environment,
        GIT_CEILING_DIRECTORIES: resolve(home.root, "..", ".."),
        HAPPY_AGENT_PROJECTS_DIRECTORY: join(home.root, "projects"),
        HAPPY_AGENT_WORKSPACES_DIRECTORY: join(home.root, "workspaces"),
        HAPPY_GYM_INFERENCE_URL: url,
        HAPPY_GYM_TOKEN: token,
        HAPPY_HOME_DIR: home.happyHome,
        HOME: join(home.root, "home"),
    };
}

function runCli(
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly output: string }> {
    const home = environment.HAPPY_HOME_DIR;
    if (home === undefined || home === resolve(process.env.HOME ?? "", ".happy")) {
        throw new Error("The reload gym only runs the CLI against its own throwaway home.");
    }
    return new Promise((done, fail) => {
        const [executable, ...prefix] = COMMAND;
        const child = spawn(executable!, [...prefix, ...args], {
            cwd: environment.HOME,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        child.once("error", fail);
        child.once("exit", (code) => done({ code, output }));
    });
}

// --- Observation ----------------------------------------------------------------------------

async function openAgent(client: HappyAgentClient, home: GymHome) {
    const registered = await client.registerProject({ path: home.workspacePath });
    await until(async () => {
        const project = (await client.getProject(registered.project.id)).project;
        return project.initialization.status === "ready" ? project : undefined;
    }, "the project to be ready");
    const agent = (await client.createAgent({ workspaceId: registered.project.id })).agent;
    return {
        agentId: agent.id,
        mode: {
            effort: "high",
            modelId: CLAUDE_MODEL,
            permissionMode: "full_access",
            providerId: "claude",
            serviceTier: null,
        } as const,
    };
}

function toolCallStatus(history: unknown, name: string): string | undefined {
    const runs = (history as { runs: { messages: { content: unknown[] }[] }[] }).runs;
    for (const run of runs) {
        for (const message of run.messages) {
            for (const block of message.content) {
                const call = block as { type?: string; name?: string; status?: string };
                if (call.type === "tool_call" && call.name === name) return call.status;
            }
        }
    }
    return undefined;
}

/** Read reload.json as fast as it changes until the reload command exits. */
async function watchStatus(
    read: () => Promise<ReloadStatus | undefined>,
    observed: ReloadStatus[],
    exited: Promise<unknown>,
): Promise<void> {
    let finished = false;
    void exited.finally(() => (finished = true));
    let last = "";
    for (;;) {
        const status = await read();
        const key = status === undefined ? "" : `${status.phase}:${String(status.updatedAt)}`;
        if (status !== undefined && key !== last) {
            observed.push(status);
            last = key;
        }
        if (finished) return;
        await new Promise((resume) => setTimeout(resume, 10));
    }
}

function phasesInOrder(statuses: readonly ReloadStatus[]): string[] {
    const phases: string[] = [];
    for (const status of statuses) if (phases.at(-1) !== status.phase) phases.push(status.phase);
    return phases;
}

async function exists(path: string): Promise<boolean> {
    return await readFile(path).then(
        () => true,
        () => false,
    );
}

async function until<Value>(
    check: () => Promise<Value | undefined>,
    description: string,
    timeoutMs = 60_000,
): Promise<Value> {
    const deadline = Date.now() + timeoutMs;
    let failure: unknown;
    for (;;) {
        try {
            const value = await check();
            if (value !== undefined) return value;
        } catch (error) {
            failure = error;
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${description}.`, { cause: failure });
        }
        await new Promise((resume) => setTimeout(resume, 50));
    }
}
