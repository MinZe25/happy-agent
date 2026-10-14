import type { RunnerHost } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

/** Stop everything the runner holds; a failure to confirm that makes the runner exit unsuccessfully. */
export async function disposeHost(ctx: Context, host: RunnerHost): Promise<void> {
    try {
        await host.dispose(ctx);
    } catch (error: unknown) {
        ctx.log.error("The runner could not stop everything it held.", error);
        process.exitCode = 1;
    }
}
