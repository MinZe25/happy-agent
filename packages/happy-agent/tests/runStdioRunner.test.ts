import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { computePermissions, createRunnerCompute, RunnerLink } from "@slopus/happy-agent-compute";
import { stdioRunnerChannel } from "@slopus/happy-agent-modules/runners/stdio";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

const PRODUCT = computePermissions("full_access");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `happy-agent runner <args>` from its sources, the way a daemon starts it without sudo. */
function startRunner(args: readonly string[]) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const child = spawn(
        process.execPath,
        ["--import", loader, resolve(import.meta.dirname, "../sources/cli.ts"), "runner", ...args],
        {
            cwd: "/",
            env: {
                PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
                HAPPY_RUNNER_TOKEN: "t".repeat(43),
            },
            stdio: ["pipe", "pipe", "pipe"],
        },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
        stderr += text;
    });
    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    cleanups.push(async () => {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
    });
    return { child, exited, stderr: () => stderr };
}

describe("happy-agent runner --stdio", () => {
    it("serves the daemon that started it, as its own user, and exits when the daemon goes", async () => {
        const runner = startRunner(["--stdio"]);
        const ctx = createRootContext().named("stdio-runner-test");
        const link = new RunnerLink(ctx, { name: "for the test", instanceId: "stdio-runner-test" });
        cleanups.push(() => link.close("The test is over."));

        const status = await link.accept(
            stdioRunnerChannel(runner.child.stdout, runner.child.stdin),
        );
        // The account the process runs as decides its home, whatever HOME it was started with.
        expect(status).toMatchObject({ state: "connected", runner: { home: userInfo().homedir } });

        const folder = await mkdtemp(join(tmpdir(), "happy-stdio-runner-"));
        cleanups.push(async () => await rm(folder, { force: true, recursive: true }));
        const machine = await createRunnerCompute(ctx, {
            link,
            computeId: "agent-stdio",
            cwd: folder,
        });
        await machine.fs.writeFile(PRODUCT, join(folder, "note.txt"), "written by the runner");
        await expect(machine.fs.readFile(PRODUCT, join(folder, "note.txt"))).resolves.toBe(
            "written by the runner",
        );
        // The runner's token never reaches what it starts.
        const result = await machine.shell.run({
            command: 'printf "%s|%s" "$(id -un)" "${HAPPY_RUNNER_TOKEN-unset}"',
            permissions: PRODUCT,
        });
        expect(result).toMatchObject({ exitCode: 0, stdout: `${userInfo().username}|unset` });

        // Ending its input, as a daemon that exits does, ends the runner.
        runner.child.stdin.end();
        await expect(runner.exited).resolves.toBe(0);
        expect(runner.stderr()).toContain(`is serving its daemon as ${userInfo().username}`);
    }, 30_000);

    it("takes no other options", async () => {
        const runner = startRunner(["--stdio", "--endpoint", "https://node.example"]);

        await expect(runner.exited).resolves.not.toBe(0);
        expect(runner.stderr()).toContain("happy-agent runner --stdio takes no other options.");
    }, 30_000);
});
