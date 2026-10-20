import type { Context } from "@steve.kite/stdlib";

import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionUsage } from "@/core/SessionUsage.js";

/**
 * ACP has no compaction method, so the foreign agent is asked for a handoff summary in its own
 * session and the next run starts a fresh session from that summary.
 */
export async function acpCompactWithAgent(
    ctx: Context,
    options: SessionCompactionOptions,
    run: (ctx: Context, request: SessionRunRequest) => AsyncIterable<SessionEvent>,
): Promise<SessionCompaction> {
    const original = options.context;
    if (ctx.lifetime?.aborted) return { status: "cancelled", context: original };
    const ask =
        "Summarize this conversation so far for a handoff: the goal, decisions made, files " +
        "changed, current state, and what remains. Reply with the summary only and call no tools." +
        (options.instructions === undefined ? "" : `\n\n${options.instructions}`);
    let summary = "";
    let usage: SessionUsage | undefined;
    let done: Extract<SessionEvent, { type: "done" }> | undefined;
    for await (const event of run(ctx, {
        context: {
            instructions: original.instructions,
            messages: [
                ...original.messages,
                { role: "user", content: [{ type: "text", text: ask }] },
            ],
        },
        ...(options.model === undefined ? {} : { model: options.model }),
    })) {
        if (event.type === "text_delta") summary += event.delta;
        if (event.type === "token_usage") usage = event.usage;
        if (event.type === "done") done = event;
    }
    if (done === undefined || done.state === "cancelled") {
        return { status: "cancelled", context: original };
    }
    if (done.state === "error") {
        return { status: "failed", kind: "inference_error", message: done.message };
    }
    if (done.state === "tool_call") {
        return {
            status: "failed",
            kind: "tool_call",
            message: "The agent called a Happy tool while compacting.",
        };
    }
    if (summary.trim().length === 0) {
        return {
            status: "failed",
            kind: "invalid_summary",
            message: "The agent returned an empty summary.",
        };
    }
    const preservedMessages = original.messages.filter((message) => message.role === "system");
    const context: SessionContext = {
        instructions: original.instructions,
        messages: [
            ...preservedMessages,
            { role: "user", content: [{ type: "text", text: summary }] },
        ],
    };
    const output = Math.ceil(summary.length / 4);
    return {
        status: "completed",
        summary,
        preservedMessages,
        usage: usage ?? { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output },
        context,
    };
}
