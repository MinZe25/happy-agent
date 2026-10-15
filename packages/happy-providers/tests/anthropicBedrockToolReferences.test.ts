import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { AnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { AnthropicBedrockProvider } from "@/vendors/bedrock/AnthropicBedrockProvider.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { testContext } from "./testContext.js";

const model = "anthropic/fable-5-1";
const missing = "mcp__builder-mcp__ReadInternalWebsites";
const toolSearch: SessionTool = {
    name: "ToolSearch",
    server: { type: "tool_search_tool_regex", name: "tool_search_tool_regex" },
};
const bash: SessionTool = { name: "Bash", parameters: Type.Object({ command: Type.String() }) };
const mcpTool: SessionTool = {
    name: missing,
    description: "Read an internal website.",
    parameters: Type.Object({ url: Type.String() }),
    defer: true,
};
const searchCall = {
    type: "server_tool_use",
    id: "srvtoolu_search",
    name: "tool_search_tool_regex",
    input: { pattern: "internal" },
};
const searchResult = {
    type: "tool_search_tool_result",
    tool_use_id: "srvtoolu_search",
    content: {
        type: "tool_search_tool_search_result",
        tool_references: [
            { type: "tool_reference", tool_name: missing },
            { type: "tool_reference", tool_name: "Bash" },
        ],
    },
};
const foundText = { type: "text", text: "Found it." };
const checkpoint = {
    type: "compaction",
    content: "The conversation found an internal website reader.",
    encrypted_content: "opaque-native-checkpoint",
};

describe("Bedrock replay of tool-search references to withdrawn tools", () => {
    it("declares a deferred placeholder so inference and compaction send history unchanged", async () => {
        const requests: AnthropicRequest[] = [];
        const context = await discoveredContext();
        const before = structuredClone(context);
        const session = await sessionWith(requests, [bash, toolSearch]);
        try {
            const events = await collect(session.run(testContext, { context, model }));
            expect(events.at(-1), JSON.stringify(events)).toMatchObject({
                type: "done",
                state: "normal",
            });
            const compaction = await session.compact(testContext, { context });
            expect(compaction, JSON.stringify(compaction)).toMatchObject({
                status: "completed",
                compaction: { encryptedContent: checkpoint.encrypted_content },
            });
        } finally {
            session.destroy();
        }

        expect(context).toEqual(before);
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(danglingReferences(request)).toEqual([]);
            expect(request.tools).toEqual([
                expect.objectContaining({ name: "Bash" }),
                { type: "tool_search_tool_regex", name: "tool_search_tool_regex" },
                {
                    name: missing,
                    description:
                        "Unavailable: an earlier search found this tool, but it is no longer offered. Calls to it fail.",
                    input_schema: { type: "object" },
                    defer_loading: true,
                },
            ]);
            expect(request.messages[1]?.content).toEqual([searchCall, searchResult, foundText]);
        }
        expect(requests[1]?.context_management?.edits).toContainEqual(
            expect.objectContaining({ type: "compact_20260112", pause_after_compaction: true }),
        );
    });

    it("leaves a model call to the placeholder for the caller to refuse as an unknown tool", async () => {
        const requests: AnthropicRequest[] = [];
        const context = await discoveredContext();
        const session = await sessionWith(requests, [bash, toolSearch], () =>
            response(
                [
                    {
                        type: "tool_use",
                        id: "toolu_withdrawn",
                        name: missing,
                        input: { url: "https://example.test" },
                    },
                ],
                "tool_use",
            ),
        );
        try {
            const events = await collect(session.run(testContext, { context, model }));
            expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
            const call = events.find((event) => event.type === "toolcall_start");
            expect(call).toEqual({
                type: "toolcall_start",
                callId: "toolu_withdrawn",
                name: missing,
                vendor: { type: "claude_tool_use" },
            });
        } finally {
            session.destroy();
        }
    });

    it("omits only the dangling references from the request copy without native tool search", async () => {
        const requests: AnthropicRequest[] = [];
        const context = await discoveredContext();
        const before = structuredClone(context);
        const session = await sessionWith(requests, [bash]);
        try {
            const events = await collect(session.run(testContext, { context, model }));
            expect(events.at(-1), JSON.stringify(events)).toMatchObject({
                type: "done",
                state: "normal",
            });
            const compaction = await session.compact(testContext, { context });
            expect(compaction, JSON.stringify(compaction)).toMatchObject({ status: "completed" });
        } finally {
            session.destroy();
        }

        expect(context).toEqual(before);
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(danglingReferences(request)).toEqual([]);
            expect(request.tools).toEqual([expect.objectContaining({ name: "Bash" })]);
            expect(request.tools?.some((tool) => "defer_loading" in tool)).toBe(false);
            expect(request.messages[1]?.content).toEqual([
                searchCall,
                {
                    ...searchResult,
                    content: {
                        ...searchResult.content,
                        tool_references: [{ type: "tool_reference", tool_name: "Bash" }],
                    },
                },
                foundText,
            ]);
        }
    });

    it("sends the real definition again once the tool returns", async () => {
        const requests: AnthropicRequest[] = [];
        const context = await discoveredContext();
        const session = await sessionWith(requests, [bash, toolSearch, mcpTool]);
        try {
            await collect(session.run(testContext, { context, model }));
        } finally {
            session.destroy();
        }

        expect(danglingReferences(requests[0]!)).toEqual([]);
        expect(
            requests[0]?.tools?.filter((tool) => "name" in tool && tool.name === missing),
        ).toEqual([
            {
                name: missing,
                description: "Read an internal website.",
                input_schema: expect.objectContaining({ type: "object" }),
                defer_loading: true,
            },
        ]);
    });
});

/** History in which native search found the MCP tool while its server was still connected. */
async function discoveredContext(): Promise<SessionContext> {
    const requests: AnthropicRequest[] = [];
    const initial: SessionContext = {
        instructions: "Use the tools.",
        messages: [{ role: "user", content: [{ type: "text", text: "Read the internal site." }] }],
    };
    const session = await sessionWith(requests, [bash, toolSearch, mcpTool], () =>
        response([searchCall, searchResult, foundText]),
    );
    try {
        const events = await collect(session.run(testContext, { context: initial, model }));
        const assistant = assistantMessageFromEvents(events);
        if (assistant === undefined) throw new Error("Expected the tool-search response.");
        return {
            ...initial,
            messages: [
                ...initial.messages,
                assistant,
                { role: "user", content: [{ type: "text", text: "Continue." }] },
            ],
        };
    } finally {
        session.destroy();
    }
}

async function sessionWith(
    requests: AnthropicRequest[],
    tools: readonly SessionTool[],
    answer: () => Response = () => response([{ type: "text", text: "Continued." }]),
) {
    const client = new AnthropicBedrockMantle({
        apiKey: "test-only-placeholder",
        awsRegion: "us-east-1",
        maxRetries: 0,
        fetch: async (_url, init) => {
            const request = JSON.parse(String(init?.body)) as AnthropicRequest;
            requests.push(request);
            // Reproduce Bedrock's validation of replayed references through the real SDK.
            const dangling = danglingReferences(request)[0];
            if (dangling !== undefined) {
                return new Response(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "invalid_request_error",
                            message: `Tool reference '${dangling}' not found in available tools`,
                        },
                    }),
                    { status: 400, headers: { "content-type": "application/json" } },
                );
            }
            const compacting = request.context_management?.edits?.some(
                (edit) => edit.type === "compact_20260112" && edit.pause_after_compaction,
            );
            return compacting ? response([checkpoint], "compaction") : answer();
        },
    });
    const credential = await BedrockBearerTokenCredential.tryLoad({
        bearerToken: "test-only-placeholder",
    });
    if (credential === null) throw new Error("Expected a test credential.");
    const provider = new AnthropicBedrockProvider({
        client,
        credential,
        model,
        inferenceMaxRetries: 0,
    });
    return await provider.session("withdrawn-tool-references", {
        instructions: "Use the tools.",
        tools,
    });
}

function danglingReferences(request: AnthropicRequest): string[] {
    const offered = new Set(request.tools?.flatMap((tool) => ("name" in tool ? [tool.name] : [])));
    return request.messages.flatMap((message) =>
        typeof message.content === "string"
            ? []
            : message.content.flatMap((block) =>
                  block.type === "tool_search_tool_result" && "tool_references" in block.content
                      ? block.content.tool_references
                            .map((reference) => reference.tool_name)
                            .filter((name) => !offered.has(name))
                      : [],
              ),
    );
}

async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function response(blocks: readonly unknown[], stopReason = "end_turn"): Response {
    const events = [
        {
            type: "message_start",
            message: {
                id: "msg-withdrawn-tool-references",
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
            },
        },
        ...blocks.flatMap((content_block, index) => [
            { type: "content_block_start", index, content_block },
            { type: "content_block_stop", index },
        ]),
        {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 10 },
        },
        { type: "message_stop" },
    ];
    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
    );
}
