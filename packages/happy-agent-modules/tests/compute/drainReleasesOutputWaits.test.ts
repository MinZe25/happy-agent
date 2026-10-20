import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AgentKV,
    withAgentConfig,
    withAgentPermissionMode,
    type AgentModuleScope,
    type AgentToolCall,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { testConfig } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const root = createRootContext().named("compute-drain-output-waits-test");
const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Claude's tools over this computer's real shell, in a folder of the test's own. */
async function machine(model: string) {
    const cwd = await mkdtemp(join(tmpdir(), "compute-drain-"));
    const module = new ComputeModule(testConfig, new SecretsModule());
    // The test already runs inside a sandbox, so the commands it starts run unrestricted.
    const ctx = withAgentPermissionMode(
        withAgentConfig(root, { modules: { compute: { cwd } } }),
        "full_access",
    );
    cleanups.push(async () => {
        await module.dispose(ctx);
        await rm(cwd, { force: true, recursive: true });
    });
    const kv = new AgentKV(new InMemoryPersistence(), "kv.drain-agent.").scoped(
        "module",
        "compute",
    );
    const scope = { agent: { id: "drain-agent", model }, kv } as AgentModuleScope;
    const hooks = await resolveModuleHooks(ctx, module);
    const tools = await hooks.tools!(ctx, scope);
    const call = {
        id: "draincall",
        kv: kv.scoped("call", "draincall"),
        commit: async (_commitCtx: Context, result: unknown) => result,
    } as AgentToolCall;
    const tool = (name: string): AnyAgentTool => {
        const found = tools.find((candidate) => candidate.name === name);
        if (found === undefined) throw new Error(`The module offers no tool called ${name}.`);
        return found;
    };
    const run = async (name: string, input: unknown): Promise<any> =>
        await tool(name).execute(ctx, input, call);
    /** The text the model is shown for one result. */
    const shown = (name: string, result: unknown): string =>
        tool(name)
            .toLLM(result)
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
    return { cwd, module, run, shown };
}

describe.skipIf(process.platform === "win32")("a drain releases output waits", () => {
    it("answers a blocking BashOutput at once with its output, and the command keeps running", async () => {
        const { cwd, module, run, shown } = await machine("anthropic/opus-5");
        const started = await run(SHELL, {
            command:
                "while [ ! -e go ]; do sleep 0.05; done; printf 'first\\n'; : > printed; sleep 30; printf 'never\\n'",
            run_in_background: true,
        });
        const bashId: string = started.bash_id;
        expect(bashId).toEqual(expect.any(String));

        const reading = run(`${SHELL}Output`, { bash_id: bashId, block: true, timeout: 600_000 });
        // The command prints only once the read is already waiting.
        await writeFile(join(cwd, "go"), "");
        await vi.waitFor(async () => await access(join(cwd, "printed")), { timeout: 10_000 });

        const releasedAt = Date.now();
        module.releaseOutputWaits();
        const released = await reading;

        expect(Date.now() - releasedAt).toBeLessThan(2_000);
        expect(released).toMatchObject({
            bash_id: bashId,
            output: "first\n",
            restarting: true,
            retrieval_status: "timeout",
            status: "running",
        });

        // Nothing was consumed without being returned, nothing is returned twice, the command is
        // still running, and a later read does not wait either.
        const laterAt = Date.now();
        const later = await run(`${SHELL}Output`, {
            bash_id: bashId,
            block: true,
            timeout: 600_000,
        });
        expect(Date.now() - laterAt).toBeLessThan(2_000);
        expect(later).toMatchObject({ output: "", restarting: true, status: "running" });
        expect(shown(`${SHELL}Output`, released)).toContain(
            "Happy Agent is restarting, so this read stopped waiting before the command finished.",
        );

        const stopped = await run(`${SHELL}Stop`, { bash_id: bashId });
        expect(stopped).toMatchObject({ bash_id: bashId, stopped: true });
    }, 30_000);

    it("answers a Codex empty poll at once with its output", async () => {
        const { cwd, module, run, shown } = await machine("openai/gpt-5.6-sol");
        const started = await run("exec_command", {
            cmd: "sleep 0.5; printf 'first\\n'; : > printed; sleep 30",
            yield_time_ms: 250,
        });
        const sessionId: number = started.session_id;
        expect(sessionId).toEqual(expect.any(Number));

        const polling = run("write_stdin", { session_id: sessionId, yield_time_ms: 300_000 });
        await vi.waitFor(async () => await access(join(cwd, "printed")), { timeout: 10_000 });
        const releasedAt = Date.now();
        module.releaseOutputWaits();
        const released = await polling;

        expect(Date.now() - releasedAt).toBeLessThan(2_000);
        expect(released.output).toContain("first");
        expect(released).toMatchObject({ restarting: true, session_id: sessionId });
        expect(shown("write_stdin", released)).toContain("Happy Agent is restarting");
        await run("kill_session", { session_id: sessionId });
    }, 30_000);

    it("leaves a foreground command to finish", async () => {
        const { module, run } = await machine("anthropic/opus-5");
        module.releaseOutputWaits();

        const result = await run(SHELL, { command: "sleep 0.3; printf 'done\\n'" });

        expect(result).toMatchObject({ exitCode: 0, stdout: "done\n" });
    }, 30_000);
});
