import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    computePermissions,
    createRunnerCompute,
    RunnerUnavailableError,
} from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { LocalUserRunner } from "../../../sources/runners/impl/LocalUserRunner.js";
import {
    sudoRunnerCommand,
    type LocalRunnerCommand,
} from "../../../sources/runners/impl/sudoRunnerCommand.js";

const PRODUCT = computePermissions("full_access");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function runnerFor(command: LocalRunnerCommand, user = "happy-work"): LocalUserRunner {
    const runner = new LocalUserRunner(createRootContext().named("local-user-runner-test"), {
        user,
        command,
        instanceId: "local-user-runner-test",
    });
    cleanups.push(async () => await runner.close("The test is over."));
    return runner;
}

/** A stand-in for sudo that refuses the way sudo does, saying what it says. */
function refusingSudo(message: string): LocalRunnerCommand {
    return {
        program: process.execPath,
        args: ["-e", `process.stderr.write(${JSON.stringify(`${message}\n`)}); process.exit(1)`],
        environment: {},
    };
}

describe("a workload user's runner", () => {
    it("fails closed with what to fix when sudo has no rule for it", async () => {
        const runner = runnerFor(refusingSudo("sudo: a password is required"));

        const failure = await runner.ready().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RunnerUnavailableError);
        expect((failure as Error).message).toMatch(
            /^Agent work cannot run as the Linux user happy-work: sudo does not allow this daemon to start its runner as that user \(sudo: a password is required\)\. Install the sudoers rule from the hardening recipe/u,
        );
        expect(runner.link.status().state).toBe("disconnected");
        // A failure moments ago is reported again rather than retried.
        await expect(runner.ready()).rejects.toBe(failure);
        expect(runner.lastFailure).toBe((failure as Error).message);
    });

    it("names the sudoers rule exactly as the real command needs it", async () => {
        const command = sudoRunnerCommand("happy-work", "/usr/local/bin/happy-agent");
        const refusing = refusingSudo("sudo: a password is required");
        const runner = runnerFor({
            ...refusing,
            args: [...refusing.args, ...command.args.slice(3)],
        });

        await expect(runner.ready()).rejects.toThrow(
            'which allows exactly "/usr/local/bin/happy-agent runner --stdio" as happy-work.',
        );
    });

    it("explains an unknown user and a missing program", async () => {
        await expect(
            runnerFor(refusingSudo("sudo: unknown user happy-nobody"), "happy-nobody").ready(),
        ).rejects.toThrow(
            "Agent work cannot run as the Linux user happy-nobody: there is no such user on this machine.",
        );
        await expect(
            runnerFor({ program: "/nonexistent/sudo", args: [], environment: {} }).ready(),
        ).rejects.toThrow(
            "Agent work cannot run as the Linux user happy-work: /nonexistent/sudo is not installed on this machine.",
        );
    });

    it("reports a runner that stops before it is ready, with its own last words", async () => {
        const runner = runnerFor(refusingSudo("happy-agent: cannot open the supervisor"));

        await expect(runner.ready()).rejects.toThrow(
            "Agent work cannot run as the Linux user happy-work: its runner stopped before it was ready (it exited with status 1: happy-agent: cannot open the supervisor).",
        );
    });

    it("serves agent files and programs from a real runner process over its pipes", async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "happy-local-runner-")));
        cleanups.push(async () => await rm(home, { force: true, recursive: true }));
        const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
        const runner = runnerFor({
            program: process.execPath,
            args: ["--import", loader, resolve(import.meta.dirname, "stdioRunner.child.ts"), home],
            environment: {
                PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
            },
        });

        await runner.ready();
        expect(runner.link.status()).toMatchObject({ state: "connected", runner: { home } });
        const ctx = createRootContext().named("local-user-runner-machine");
        const machine = await createRunnerCompute(ctx, {
            link: runner.link,
            computeId: "agent-test",
            cwd: home,
        });
        await machine.fs.writeFile(PRODUCT, join(home, "hello.txt"), "from the runner");
        await expect(machine.fs.readFile(PRODUCT, join(home, "hello.txt"))).resolves.toBe(
            "from the runner",
        );
        const started = await machine.processes!.start(ctx, { command: "id", args: ["-un"] });
        const output: Buffer[] = [];
        started.onStdout((chunk) => output.push(Buffer.from(chunk)));
        started.endInput();
        await expect(started.exited).resolves.toMatchObject({ exitCode: 0 });
        // Without sudo in front, the runner runs as whoever ran the test.
        expect(Buffer.concat(output).toString().trim()).toBe(userInfo().username);

        await runner.close("The test is over.");
        expect(runner.link.status().state).toBe("closed");
        await expect(runner.ready()).rejects.toThrow("because the daemon is shutting down");
    });
});
