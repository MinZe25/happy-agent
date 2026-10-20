import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeCommandOutcome } from "./startComputeCommand.js";

/** What a read released by a restart tells the model, beside the output it did collect. */
export const OUTPUT_WAIT_RELEASED_NOTICE =
    "Happy Agent is restarting, so this read stopped waiting before the command finished.";

/**
 * Collect what a command has produced since it was last read.
 *
 * Only new output comes back. The model already has everything it was told before, and repeating
 * the whole log on every read spends the context on repetition. A command that has ended keeps
 * answering for a while, so its last words are never lost to a read that arrived late.
 *
 * `released` ends the wait early without cancelling the read: the shell stops waiting and still
 * answers with what the command has said so far, so the tool returns it through its ordinary
 * result. The daemon raises it when it starts draining, because a read that is only waiting must
 * not hold a reload open for as long as it was allowed to wait. `released` in the outcome says the
 * read ended that way, with the command still running. A machine whose transport would lose a
 * cancelled read's output passes no signal and keeps waiting.
 */
export async function readComputeCommand(
    compute: Compute,
    ctx: Context,
    options: {
        readonly commandId: number;
        readonly waitMs: number;
        readonly released?: AbortSignal | undefined;
    },
): Promise<ComputeCommandOutcome & { readonly released: boolean }> {
    const startedAt = Date.now();
    const signals = [ctx.lifetime, options.released].filter(
        (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const snapshot = await compute.shell.readSession(options.commandId, {
        ...(signal === undefined ? {} : { signal }),
        waitMs: options.waitMs,
    });
    if (snapshot === undefined) {
        throw new Error(`There is no command ${String(options.commandId)} on this machine.`);
    }
    return {
        released:
            options.released?.aborted === true &&
            ctx.lifetime?.aborted !== true &&
            snapshot.status === "running",
        snapshot,
        wallTimeSeconds: (Date.now() - startedAt) / 1_000,
    };
}
