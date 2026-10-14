import { join } from "node:path";
import { userInfo } from "node:os";
import { format } from "node:util";

import { stdioRunnerChannel } from "@slopus/happy-agent-modules/runners/stdio";
import { createRootContext, withLogger } from "@steve.kite/stdlib";

import { AgentDaemonError } from "../lifecycle/AgentDaemonError.js";
import { createRunnerHostFor } from "./createRunnerHostFor.js";
import { createRunnerLogger } from "./createRunnerLogger.js";
import { disposeHost } from "./disposeHost.js";

/**
 * Serve the daemon that started this process, over its standard input and output, until the
 * daemon goes away — then stop everything it started here and exit.
 *
 * This is how a daemon runs agent work as another Linux user on its own machine: it starts
 * `happy-agent runner --stdio` through sudo as that user, so this process holds that user's
 * rights and nothing of the daemon's — no configuration, database, credentials, or environment.
 * Standard output carries only protocol frames; everything else goes to standard error, which the
 * daemon writes to its log. Ending the input, as a daemon that exits or dies does, ends the runner,
 * so nothing a daemon starts here outlives it.
 */
export async function runStdioRunner(args: readonly string[]): Promise<void> {
    if (args.length !== 1 || args[0] !== "--stdio") {
        throw new AgentDaemonError("happy-agent runner --stdio takes no other options.", {
            hint: "A daemon starts this runner itself; run happy-agent runner --help to see the rest.",
        });
    }
    // Only frames may reach standard output; a stray console line would break the protocol.
    for (const method of ["log", "info", "debug"] as const) {
        console[method] = (...values: unknown[]) => {
            process.stderr.write(`${format(...values)}\n`);
        };
    }
    // The account this process runs as, not whatever HOME sudo's policy left in place, decides
    // where its folders live and what the commands it starts see as their home.
    const account = userInfo();
    process.env["HOME"] = account.homedir;
    process.env["USER"] = account.username;
    process.env["LOGNAME"] = account.username;
    delete process.env["HAPPY_RUNNER_TOKEN"];
    delete process.env["HAPPY_RUNNER_ENDPOINT"];

    const logger = createRunnerLogger(process.env["HAPPY_RUNNER_DEBUG"] === "1");
    const root = withLogger(createRootContext(), logger);
    const ctx = root.named("runner");
    const { host, identity } = createRunnerHostFor(ctx, {
        home: account.homedir,
        privateDirectories: [join(account.homedir, ".happy-runner")],
    });
    const channel = stdioRunnerChannel(process.stdin, process.stdout);
    const stop = (signal: string) => {
        ctx.log.info(`The runner is stopping after ${signal}.`);
        channel.close("The runner is shutting down.");
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGHUP", () => stop("SIGHUP"));

    ctx.log.info(
        `Happy Agent runner ${identity.version} is serving its daemon as ${account.username}.`,
    );
    const reason = await host.serve(channel);
    ctx.log.info(`The daemon's connection ended: ${reason}`);
    await disposeHost(root.named("runner-shutdown"), host);
    // Nothing this runner started may outlive the daemon that started it, so the process ends
    // here rather than waiting on whatever handles are still open.
    process.exit(process.exitCode ?? 0);
}
