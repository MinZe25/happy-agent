import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AgentKV,
    ensureAgentDatabaseConnection,
    withAgentConfig,
    withAgentPermissionMode,
    type AgentModuleScope,
    type AgentToolCall,
} from "@slopus/happy-agent-base";
import {
    createHostCompute,
    createRunnerChannelPair,
    RunnerHost,
} from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { testConfig } from "../support/computeModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const TOKEN = "a".repeat(43);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Claude's tools over a folder on a connected runner, served from a temporary home here. */
async function runnerMachine() {
    const home = await realpath(await mkdtemp(join(tmpdir(), "happy-runner-drain-")));
    cleanups.push(async () => await rm(home, { force: true, recursive: true }));
    const config = {
        get runners() {
            return { defaultId: "build-box", entries: { "build-box": { token: TOKEN } } };
        },
    } as unknown as ConfigModule;
    const runners = new RunnersModule(config);
    const database = moduleDatabase(runners.migrations, "runner-drain-test");
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    runners.beforeStart(database.context);
    cleanups.push(() => database.close());
    cleanups.push(async () => await runners.close());
    const host = new RunnerHost({
        ctx: database.rootContext.named("test-runner"),
        identity: { version: "9.9.9", platform: "linux", arch: "x64", hostname: "box", home },
        createCompute: async (computeCtx, request) =>
            createHostCompute({ ctx: computeCtx, cwd: request.cwd }),
    });
    cleanups.push(async () => await host.dispose(database.rootContext.named("runner-dispose")));
    const connected = new Promise<void>((resolve) => {
        const stop = runners.onUpdated((_ctx, snapshot) => {
            if (snapshot.runners[0]?.status !== "connected") return;
            stop();
            resolve();
        });
    });
    const [daemonSide, runnerSide] = createRunnerChannelPair();
    void runners.accept("build-box", daemonSide);
    void host.serve(runnerSide);
    await connected;

    const module = new ComputeModule(testConfig, new SecretsModule(), runners);
    // The test already runs inside a sandbox, so the commands it starts run unrestricted.
    const ctx = withAgentPermissionMode(
        withAgentConfig(database.context, {
            modules: { compute: { cwd: home, runnerId: "build-box" } },
        }),
        "full_access",
    );
    cleanups.push(async () => await module.dispose(ctx));
    const kv = new AgentKV(new InMemoryPersistence(), "kv.runner-agent.").scoped(
        "module",
        "compute",
    );
    const scope = {
        agent: { id: "runneragent", model: "anthropic/opus-5" },
        kv,
    } as AgentModuleScope;
    const hooks = await resolveModuleHooks(ctx, module);
    const tools = await hooks.tools!(ctx, scope);
    const call = {
        id: "runnercall",
        kv: kv.scoped("call", "runnercall"),
        commit: async (_commitCtx: Context, result: unknown) => result,
    } as AgentToolCall;
    const run = async (name: string, input: unknown): Promise<any> => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`The module offers no tool called ${name}.`);
        return await tool.execute(ctx, input, call);
    };
    return { home, module, run };
}

describe.skipIf(process.platform === "win32")("a drain and a runner's output reads", () => {
    it("keeps a runner read waiting, so none of the output it consumed is lost", async () => {
        const { home, module, run } = await runnerMachine();
        const started = await run("Bash", {
            command:
                "while [ ! -e go ]; do sleep 0.05; done; printf 'first\\n'; : > printed; sleep 1; printf 'second\\n'",
            run_in_background: true,
        });
        expect(started).toMatchObject({ bash_id: expect.any(String) });

        const reading = run("BashOutput", {
            bash_id: started.bash_id,
            block: true,
            timeout: 20_000,
        });
        await writeFile(join(home, "go"), "");
        await vi.waitFor(async () => await access(join(home, "printed")), { timeout: 10_000 });
        const releasedAt = Date.now();
        module.releaseOutputWaits();
        const result = await reading;

        // A released runner read would have been cancelled with "first" already consumed on the
        // runner. Instead it waited for the command, and answered with everything it said.
        expect(Date.now() - releasedAt).toBeGreaterThanOrEqual(500);
        expect(result).toMatchObject({
            output: "first\nsecond\n",
            retrieval_status: "success",
            status: "completed",
        });
        expect(result).not.toHaveProperty("restarting");
    }, 30_000);
});
