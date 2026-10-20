import { describe, expect, it } from "vitest";

import { isNetworkFailure } from "@/core/isNetworkFailure.js";
import { sessionProviderErrorSchema } from "@/core/SessionProviderError.js";
import { Value } from "@sinclair/typebox/value";
import { classifyAnthropicBedrockProviderError } from "@/vendors/bedrock/errors/anthropicBedrockErrors.js";
import {
    classifyCodexError,
    classifyCodexProviderError,
} from "@/vendors/codex/errors/codexErrors.js";
import { classifyGrokProviderError } from "@/vendors/grok/errors/grokErrors.js";

function fetchFailed(code: string): Error {
    const cause = Object.assign(new Error(`connect ${code} 104.18.0.1:443`), { code });
    return new TypeError("fetch failed", { cause });
}

describe("Codex context overflow classification", () => {
    it.each([
        "context_length_exceeded",
        "Your input exceeds the context window of this model. Please adjust your input and try again.",
        "This model's maximum context length is 272000 tokens.",
        "prompt is too long: 300000 tokens > 272000 maximum",
    ])("recognizes an overflow: %s", (message) => {
        expect(classifyCodexError(message)).toBe("context_overflow");
    });

    it.each([
        "Missing required parameter: 'context'.",
        "Invalid value for 'reasoning.context': expected an object.",
        "Failed to load conversation context from the previous response.",
    ])("does not mistake an unrelated mention of context for an overflow: %s", (message) => {
        expect(classifyCodexError(message)).not.toBe("context_overflow");
    });
});

describe("network failure classification", () => {
    it.each([
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_SOCKET",
    ])("finds %s on the cause chain", (code) => {
        expect(isNetworkFailure(fetchFailed(code), "fetch failed")).toBe(true);
    });

    it("does not call an answered request a network failure", () => {
        const answered = Object.assign(new Error("Internal server error"), { status: 500 });
        expect(isNetworkFailure(answered, answered.message)).toBe(false);
    });

    it.each([
        ["codex", (error: Error) => classifyCodexProviderError(error, error.message, 3)],
        ["grok", (error: Error) => classifyGrokProviderError(error, error.message, 3)],
        ["bedrock", (error: Error) => classifyAnthropicBedrockProviderError(error, 3)],
    ] as const)("%s reports an unreachable vendor as network", (_vendor, classify) => {
        const providerError = classify(fetchFailed("ECONNRESET"));
        expect(providerError.type).toBe("network");
        expect(Value.Check(sessionProviderErrorSchema, providerError)).toBe(true);
    });

    it("keeps a vendor 5xx an internal server error", () => {
        const error = Object.assign(new Error("API error (status 502): bad gateway"), {
            status: 502,
        });
        expect(classifyCodexProviderError(error, error.message, 1).type).toBe(
            "internal_server_error",
        );
    });
});
