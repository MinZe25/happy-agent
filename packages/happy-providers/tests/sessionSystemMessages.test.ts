import { describe, expect, it } from "vitest";

import type { SessionContext } from "@/core/SessionContext.js";
import { toOpenAIResponseInput } from "@/protocol/responses/toOpenAIResponseInput.js";
import { toAnthropicMessages } from "@/protocol/anthropic/toAnthropicMessages.js";
import { toAnthropicSystem } from "@/protocol/anthropic/toAnthropicSystem.js";
import { createClaudeSessionReplay } from "@/vendors/claude/impl/createClaudeSessionReplay.js";
import { toGrokResponseInput } from "@/vendors/grok/impl/toGrokResponseInput.js";

const CONTEXT: SessionContext = {
    instructions: "Base instructions.",
    messages: [
        {
            role: "user",
            content: [{ type: "text" as const, text: "Read the config." }],
        },
        {
            role: "assistant",
            content: [{ type: "text" as const, text: "Reading it now." }],
        },
        {
            role: "system",
            content: [{ type: "text" as const, text: "Permission mode is now Auto." }],
        },
        {
            role: "user",
            content: [{ type: "text" as const, text: "Continue." }],
        },
    ],
};

const REMINDER = "<system-reminder>\nPermission mode is now Auto.\n</system-reminder>";

describe("Session system messages", () => {
    it("keeps a Claude notice in position instead of folding it into the prompt", () => {
        const replay = createClaudeSessionReplay({
            context: CONTEXT,
            model: "claude-opus-4-8",
            sessionId: "11111111-1111-4111-8111-111111111111",
        });

        expect(
            replay
                .entries()
                .filter((entry) => entry.type !== "attachment")
                .map((entry) => (entry.message as { content: unknown }).content),
        ).toEqual(["Read the config.", [{ type: "text", text: "Reading it now." }], REMINDER]);
    });

    it("keeps a Bedrock notice in position instead of folding it into the prompt", () => {
        expect(toAnthropicSystem({ context: CONTEXT })).toEqual([
            { type: "text", text: "Base instructions.", cache_control: { type: "ephemeral" } },
        ]);
        expect(toAnthropicMessages(CONTEXT.messages)[2]).toEqual({
            role: "user",
            content: REMINDER,
        });
    });

    it("ends a continued Bedrock response with the caller's notice rather than a prefill", () => {
        const searchCall = {
            type: "server_tool_use",
            id: "srvtoolu_cut_off",
            name: "tool_search_tool_regex",
            input: { pattern: "web_fetch" },
        };
        // A response cut off mid-search after thinking and text, followed by the notice the
        // caller wrote before continuing it.
        const messages: SessionContext["messages"] = [
            { role: "user", content: [{ type: "text", text: "Open the PR." }] },
            {
                role: "assistant",
                content: [
                    { type: "reasoning", text: "Plan the PR body.", reasoning: "signature" },
                    { type: "text", text: "Meanwhile, drafting the PR body." },
                    {
                        type: "tool_call",
                        callId: searchCall.id,
                        name: "ToolSearch",
                        server: true,
                        arguments: JSON.stringify(searchCall.input),
                        vendor: { outputBlock: JSON.stringify(searchCall) },
                    },
                ],
            },
            {
                role: "system",
                content: [{ type: "text", text: "Continue from where you left off." }],
            },
        ];
        const before = structuredClone(messages);

        expect(toAnthropicMessages(messages).slice(1)).toEqual([
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Plan the PR body.", signature: "signature" },
                    { type: "text", text: "Meanwhile, drafting the PR body." },
                ],
            },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "<system-reminder>\nContinue from where you left off.\n</system-reminder>",
                        cache_control: { type: "ephemeral" },
                    },
                ],
            },
        ]);
        expect(messages).toEqual(before);
    });

    it("sends a Grok notice as a reminder rather than a conversational system turn", () => {
        const input = toGrokResponseInput(CONTEXT);

        expect(input[0]).toEqual({
            type: "message",
            role: "system",
            content: "Base instructions.",
        });
        expect(input[3]).toEqual({ type: "message", role: "user", content: REMINDER });
        expect(input.slice(1).some((item) => "role" in item && item.role === "system")).toBe(false);
    });

    it("sends a Codex notice as a developer message, which Codex supports natively", () => {
        expect(toOpenAIResponseInput(CONTEXT)[2]).toEqual({
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Permission mode is now Auto." }],
        });
    });
});
