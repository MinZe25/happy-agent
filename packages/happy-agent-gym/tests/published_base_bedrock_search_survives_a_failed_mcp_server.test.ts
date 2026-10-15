import { Type } from "@sinclair/typebox";
import {
    AgentBase,
    AgentProviders,
    defineAgentTool,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryPersistence } from "../../happy-agent-base/tests/gym/InMemoryPersistence.js";

// Like the hidden-search continuation boundary, this keeps AgentBase at its published version and
// loads the candidate provider build; set HAPPY_GYM_PUBLISHED_PROVIDER=1 to reproduce the failure
// against the published adapter.
afterEach(() => vi.unstubAllGlobals());

const mcpToolName = "mcp__builder-mcp__ReadInternalWebsites";

interface RecordedRequest {
    readonly context_management?: { readonly edits?: readonly Record<string, unknown>[] };
    readonly messages: readonly { readonly role: string; readonly content: unknown }[];
    readonly tools?: readonly Record<string, unknown>[];
}

describe("published AgentBase on Bedrock after native search found a tool of a failed MCP server", () => {
    it("keeps inference, a call to the withdrawn tool, and compaction working", async () => {
        const providerModule =
            process.env.HAPPY_GYM_PUBLISHED_PROVIDER === "1"
                ? "@slopus/happy-providers"
                : new URL("../../happy-providers/dist/index.js", import.meta.url).href;
        const providerImplementation: typeof import("@slopus/happy-providers") = await import(
            providerModule
        );
        const ctx = createRootContext().named("bedrock-search-failed-mcp-boundary");
        const search = {
            type: "server_tool_use",
            id: "srvtoolu_search",
            name: "tool_search_tool_regex",
            input: { pattern: "internal" },
        };
        const result = {
            type: "tool_search_tool_result",
            tool_use_id: search.id,
            content: {
                type: "tool_search_tool_search_result",
                tool_references: [{ type: "tool_reference", tool_name: mcpToolName }],
            },
        };
        const withdrawnCall = {
            type: "tool_use",
            id: "toolu_withdrawn",
            name: mcpToolName,
            input: { url: "https://internal.example" },
        };
        const checkpoint = {
            type: "compaction",
            content: "The conversation found an internal website reader.",
            encrypted_content: "opaque-native-checkpoint",
        };
        const requests: RecordedRequest[] = [];
        const answers = [
            () => responseFor([search, result, { type: "text", text: "FOUND" }], "end_turn"),
            () => responseFor([withdrawnCall], "tool_use"),
            () => responseFor([{ type: "text", text: "UNAVAILABLE NOTED" }], "end_turn"),
            () => responseFor([checkpoint], "compaction"),
            () => responseFor([{ type: "text", text: "AFTER COMPACTION" }], "end_turn"),
        ];
        vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
            const body =
                typeof init?.body === "string" ? init.body : await new Request(input, init).text();
            const request = JSON.parse(body) as RecordedRequest;
            requests.push(request);
            // Bedrock validates every replayed reference against this request's tools.
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
            const answer = answers[requests.length - 1];
            if (answer === undefined) throw new Error("Unexpected additional inference request.");
            return answer();
        });
        const credential = await providerImplementation.BedrockBearerTokenCredential.tryLoad({
            bearerToken: "test-only-placeholder",
        });
        if (credential === null) throw new Error("The explicit test credential was not created.");
        const providers = new AgentProviders();
        providers.add(
            "bedrock",
            new providerImplementation.AnthropicProvider({
                credential,
                model: "anthropic/fable-5-1",
                transport: "mantle",
                inferenceMaxRetries: 0,
            }),
            "bedrock",
        );
        // The MCP module offers a server's tools only while it is connected.
        let serverConnected = true;
        const mcpCalls: unknown[] = [];
        const mcpTool: AnyAgentTool = defineAgentTool({
            name: mcpToolName,
            defer: true,
            description: "Read an internal website.",
            parameters: Type.Object({ url: Type.String() }),
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: (_ctx, args) => {
                mcpCalls.push(args);
                return Promise.resolve({});
            },
            toLLM: () => [{ type: "text" as const, text: "Read." }],
        });
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "bedrock-failed-mcp-agent",
            providers,
            provider: "bedrock",
            model: "anthropic/fable-5-1",
            persistence: new InMemoryPersistence(),
            hooks: {
                onEvent: (_ctx: typeof ctx, event: SessionEvent) => {
                    events.push(event);
                },
                tools: () => (serverConnected ? [mcpTool] : []),
            },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "ToolSearch",
                        server: { type: "tool_search_tool_regex", name: search.name },
                        persistInHistory: false,
                        visibleToUser: false,
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: () =>
                            Promise.reject(new Error("Only Bedrock executes native search.")),
                        toLLM: () => [],
                    }),
                ],
            },
        });
        try {
            await agent.send(ctx, {
                role: "user",
                content: [{ type: "text", text: "Find the internal website reader." }],
            });
            await agent.waitForIdle();
            expect(events).toContainEqual({ type: "text_delta", delta: "FOUND" });
            expect(requests[0]?.tools).toContainEqual(
                expect.objectContaining({
                    name: mcpToolName,
                    description: "Read an internal website.",
                }),
            );

            serverConnected = false;
            await agent.send(ctx, {
                role: "user",
                content: [{ type: "text", text: "Read it now." }],
            });
            await agent.waitForIdle();
            expect(events).toContainEqual({ type: "text_delta", delta: "UNAVAILABLE NOTED" });
            expect(mcpCalls).toEqual([]);
            const toolResult = toolResultFor(requests[2], withdrawnCall.id);
            expect(toolResult).toMatchObject({
                is_error: true,
                content: `Tool "${mcpToolName}" is not available.`,
            });

            await agent.compact(ctx);
            await agent.waitForIdle();
            const compaction = requests[3];
            expect(compaction?.context_management?.edits).toContainEqual(
                expect.objectContaining({ type: "compact_20260112", pause_after_compaction: true }),
            );

            await agent.send(ctx, {
                role: "user",
                content: [{ type: "text", text: "Continue after compaction." }],
            });
            await agent.waitForIdle();
            expect(events).toContainEqual({ type: "text_delta", delta: "AFTER COMPACTION" });
            expect(requests).toHaveLength(5);
            expect(requests[4]?.messages[0]?.content).toEqual([
                { ...checkpoint, cache_control: { type: "ephemeral" } },
            ]);

            for (const request of requests.slice(1, 4)) {
                expect(danglingReferences(request)).toEqual([]);
                expect(request.tools).toContainEqual(
                    expect.objectContaining({ name: mcpToolName, defer_loading: true }),
                );
                const blocks = request.messages.flatMap((message) =>
                    Array.isArray(message.content) ? message.content : [],
                );
                expect(blocks).toContainEqual(result);
            }
            expect(
                events.filter(
                    (event) =>
                        event.type === "done" && (event as { state?: string }).state === "error",
                ),
            ).toEqual([]);
        } finally {
            await agent.close();
        }
    });
});

function danglingReferences(request: RecordedRequest): string[] {
    const offered = new Set(
        (request.tools ?? []).flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : [])),
    );
    return request.messages.flatMap((message) =>
        (Array.isArray(message.content) ? message.content : []).flatMap(
            (block: { type?: string; content?: { tool_references?: { tool_name: string }[] } }) =>
                block.type === "tool_search_tool_result"
                    ? (block.content?.tool_references ?? [])
                          .map((reference) => reference.tool_name)
                          .filter((name) => !offered.has(name))
                    : [],
        ),
    );
}

function toolResultFor(request: RecordedRequest | undefined, callId: string): unknown {
    return request?.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find(
            (block: { type?: string; tool_use_id?: string }) =>
                block.type === "tool_result" && block.tool_use_id === callId,
        );
}

function responseFor(blocks: readonly Record<string, unknown>[], stopReason: string): Response {
    const events: Record<string, unknown>[] = [
        {
            type: "message_start",
            message: {
                id: `msg_${stopReason}_${blocks.length}`,
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
            },
        },
    ];
    for (const [index, block] of blocks.entries()) {
        const tool = block.type === "tool_use" || block.type === "server_tool_use";
        events.push({
            type: "content_block_start",
            index,
            content_block: tool ? { ...block, input: {} } : block,
        });
        if (tool)
            events.push({
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            });
        events.push({ type: "content_block_stop", index });
    }
    events.push(
        {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
    );
    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
    );
}
