import { testContext } from "../testContext.js";

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { query as claudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";

import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";

/**
 * When a resumed transcript ends on a user-role entry, Claude Code's print-mode loader splices a
 * synthetic assistant "No response requested." after it, which the model reads as its own reply.
 * `--reply-on-resume` suppresses that only in the interactive REPL, so the replay resumes at its
 * last entry instead, and the loader's truncation drops the placeholder. These tests drive the real
 * SDK against a local server and inspect what actually reaches the API.
 */
describe("Claude replay ending on a user-role entry", () => {
    it("continues from a tool-result tail without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([user("Read the notes."), readCall(), readResult()]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            expect(messages[1]?.content).toEqual([
                expect.objectContaining({ type: "tool_use", id: "call-read" }),
            ]);
            expect(blocks(messages[2])).toEqual([
                { type: "tool_result", tool_use_id: "call-read", content: "Ship on Friday." },
                { type: "text", text: "Continue from the supplied tool result." },
            ]);
        });
    }, 15_000);

    it("delivers a notice steered after tool results without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                user("Read the notes."),
                readCall(),
                readResult(),
                {
                    role: "agent",
                    author: { id: "coordinator", description: "Coordinator" },
                    content: [{ type: "text", text: "Also check the changelog." }],
                },
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            expect(blocks(messages[2])).toEqual([
                { type: "tool_result", tool_use_id: "call-read", content: "Ship on Friday." },
                {
                    type: "text",
                    text: "<system-reminder>\nMessage from agent Coordinator (coordinator):\n\nAlso check the changelog.\n</system-reminder>",
                },
            ]);
        });
    }, 15_000);

    it("delivers a notice after an unanswered user message without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                user("Read the notes."),
                { role: "assistant", content: [{ type: "text", text: "Done." }] },
                user("Now summarize them."),
                { role: "system", content: [{ type: "text", text: "Keep it short." }] },
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            // Claude Code merges the adjacent user turns, separating them with a newline.
            expect(blocks(messages[2])).toEqual([
                { type: "text", text: "Now summarize them.\n" },
                { type: "text", text: "<system-reminder>\nKeep it short.\n</system-reminder>" },
            ]);
        });
    }, 15_000);

    it("replays an ordinary user prompt after an answer unchanged", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                user("Read the notes."),
                { role: "assistant", content: [{ type: "text", text: "Done." }] },
                user("Now summarize them."),
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            expect(blocks(messages[2])).toEqual([{ type: "text", text: "Now summarize them." }]);
        });
    }, 15_000);

    // The first-prompt attachments follow the first user entry, but the loader still treats a
    // history of leading notices alone as ending on a user turn.
    it("sends leading notices and the first prompt without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                { role: "system", content: [{ type: "text", text: "Project instructions." }] },
                user("Read the notes."),
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user"]);
            expect(blocks(messages[0])).toEqual([
                {
                    type: "text",
                    text: "<system-reminder>\nProject instructions.\n</system-reminder>\n",
                },
                { type: "text", text: "Read the notes." },
            ]);
        });
    }, 15_000);

    it("compacts a context ending on tool results with one native request", async () => {
        await withServer(async (harness) => {
            const { compaction, requests } = await harness.compact([
                user("Read the notes."),
                readCall(),
                readResult(),
            ]);

            expect(compaction.status).toBe("completed");
            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            const tail = blocks(messages[2]);
            expect(tail[0]).toEqual({
                type: "tool_result",
                tool_use_id: "call-read",
                content: "Ship on Friday.",
            });
            expect(tail[1]?.text).toContain("Your task is to create a detailed summary");
        });
    }, 15_000);
});

/**
 * The request's conversation without Claude Code's environment message, after checking that no
 * placeholder reached the API.
 */
function conversation(request: CapturedRequest): CapturedRequest["messages"] {
    expect(JSON.stringify(request.messages)).not.toContain("No response requested.");
    expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
    return request.messages.filter((message) => message.role !== "system");
}

/** Content blocks without the cache breakpoint Claude Code places on the newest turn. */
function blocks(
    message: CapturedRequest["messages"][number] | undefined,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
    if (message === undefined) return [];
    if (typeof message.content === "string") return [{ type: "text", text: message.content }];
    return (message.content as Array<Record<string, unknown>>).map(
        ({ cache_control: _cacheControl, ...block }) =>
            block as { type: string; text?: string; [key: string]: unknown },
    );
}

function user(content: string): SessionMessage {
    return { role: "user", content: [{ type: "text", text: content }] };
}

function readCall(): SessionMessage {
    return {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                callId: "call-read",
                name: "Read",
                arguments: JSON.stringify({ file_path: "/workspace/NOTES.md" }),
            },
        ],
    };
}

function readResult(): SessionMessage {
    return {
        role: "tool",
        callId: "call-read",
        content: [{ type: "text", text: "Ship on Friday." }],
    };
}

interface CapturedRequest {
    messages: Array<{ role: string; content: unknown }>;
}

async function withServer(
    scenario: (harness: {
        compact: (messages: SessionMessage[]) => Promise<{
            compaction: Awaited<ReturnType<ClaudeSession["compact"]>>;
            requests: CapturedRequest[];
        }>;
        run: (messages: SessionMessage[]) => Promise<CapturedRequest[]>;
    }) => Promise<void>,
): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "rig-claude-user-tail-"));
    const requests: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
        if (
            request.method !== "POST" ||
            !request.url?.startsWith("/v1/messages") ||
            request.url.includes("/count_tokens")
        ) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end('{"type":"error","error":{"type":"not_found_error"}}');
            return;
        }
        requests.push(JSON.parse((await readBody(request)).toString("utf8")) as CapturedRequest);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(TEXT_RESPONSE);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Claude replay server port.");
    }
    const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "user-tail-token" });
    if (credential === null) throw new Error("Expected a Claude test credential.");
    const sessions: ClaudeSession[] = [];
    const session = () => {
        const created = new ClaudeSession("<SESSION_ID>", {
            instructions: "You are a careful engineer.",
            credential,
            cwd,
            env: {
                ...process.env,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
                CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
                TZ: "UTC",
            },
            model: "anthropic/opus-5-5",
            query: claudeSdkQuery,
            tools: [{ name: "Read", description: "Read a file." }],
        });
        sessions.push(created);
        return created;
    };
    try {
        await scenario({
            compact: async (messages) => {
                const first = requests.length;
                const compaction = await session().compact(testContext, {
                    context: { instructions: "You are a careful engineer.", messages },
                });
                return { compaction, requests: requests.slice(first) };
            },
            run: async (messages) => {
                const first = requests.length;
                const events: SessionEvent[] = [];
                for await (const event of session().run(testContext, {
                    context: { instructions: "You are a careful engineer.", messages },
                })) {
                    events.push(event);
                }
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                return requests.slice(first);
            },
        });
    } finally {
        for (const created of sessions) created.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(cwd, { force: true, recursive: true });
    }
}

const TEXT_RESPONSE = toSse([
    {
        type: "message_start",
        message: {
            id: "msg_user_tail",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
        },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The notes say to ship on Friday." },
    },
    { type: "content_block_stop", index: 0 },
    {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
]);

function toSse(events: readonly unknown[]): string {
    return events
        .map(
            (event) =>
                `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
}

function readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.once("end", () => resolve(Buffer.concat(chunks)));
        request.once("error", reject);
    });
}
