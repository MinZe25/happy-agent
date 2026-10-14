import { arch, homedir, hostname } from "node:os";

import { createRunnerMachine, RunnerHost } from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";

import { stdioRunnerChannel } from "../../../sources/runners/stdio.js";

/**
 * A runner the way `happy-agent runner --stdio` is one, without sudo in front of it: a real
 * `RunnerHost` with the real runner machine, served over this process's standard input and output.
 */
async function main(): Promise<void> {
    const ctx = createRootContext().named("stdio-runner-fixture");
    const home = process.argv[2] ?? homedir();
    const host = new RunnerHost({
        ctx,
        identity: {
            version: "test",
            platform: process.platform,
            arch: arch(),
            hostname: hostname(),
            home,
        },
        createCompute: async (computeCtx, request) =>
            createRunnerMachine(computeCtx, request, { home }),
    });
    process.stderr.write("fixture runner is serving\n");
    await host.serve(stdioRunnerChannel(process.stdin, process.stdout));
    await host.dispose(ctx);
    process.exit(0);
}

void main();
