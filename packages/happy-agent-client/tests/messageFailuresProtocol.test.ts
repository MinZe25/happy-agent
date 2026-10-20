import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
    agentRetryingSchema,
    HappyAgentClient,
    isKnownMessageFailure,
    messageFailureResolutionSchema,
    messageFailureSchema,
    type AgentRetrying,
    type FailureResolutionResponse,
    type MessageFailure,
    type MessageFailureFallback,
} from "../sources/index.js";

const claude = { id: "claude", type: "claude", vendorName: "Claude", label: "claude" };
const fallback: MessageFailureFallback = {
    providerId: "claude_work",
    providerLabel: "claude_work",
    modelId: "anthropic/opus-5-5",
    usedPercent: 38,
    usageWindow: "weekly",
    group: "same_model",
};

const failures: MessageFailure[] = [
    {
        kind: "signin_missing",
        message: "Claude Code isn't signed in. Run claude auth login, then retry.",
        fallbackProviders: [fallback],
        provider: claude,
        product: "Claude Code",
        command: "claude auth login",
    },
    {
        kind: "usage_limit",
        message: "Claude usage limit reached. It resets in about 2 hours.",
        fallbackProviders: [fallback],
        provider: claude,
        resetsAt: 1_755_400_000_000,
    },
    {
        kind: "no_account_available",
        message: "Every account in Claude pool is out of usage.",
        fallbackProviders: [],
        poolName: "Claude pool",
        resetsAt: null,
    },
    {
        kind: "rate_limited",
        message: "Claude is rate-limited.",
        fallbackProviders: [],
        provider: claude,
    },
    {
        kind: "provider_unavailable",
        message: "Claude is overloaded right now.",
        fallbackProviders: [],
        provider: claude,
    },
    { kind: "network", message: "Couldn't reach Claude.", fallbackProviders: [], provider: claude },
    {
        kind: "provider_disabled",
        message: "claude_work is turned off.",
        fallbackProviders: [],
        provider: claude,
    },
    {
        kind: "context_too_long",
        message: "This conversation is too long for this model, even after a reset.",
        fallbackProviders: [],
        modelId: "anthropic/opus-5-5",
    },
    {
        kind: "internal",
        message: "Something went wrong.",
        fallbackProviders: [],
        detail: "The provider stream ended before completion.",
    },
];

describe("typed message failures", () => {
    it.each(failures)("accepts the $kind variant", (failure) => {
        expect(Value.Check(messageFailureSchema, failure)).toBe(true);
        expect(isKnownMessageFailure(failure)).toBe(true);
    });

    it("narrows each known kind to its own fields", () => {
        const failure = failures[1]!;
        if (isKnownMessageFailure(failure) && failure.kind === "usage_limit") {
            expectTypeOf(failure.resetsAt).toEqualTypeOf<number | null>();
            expectTypeOf(failure.provider.vendorName).toEqualTypeOf<string>();
        }
        expectTypeOf<
            Extract<MessageFailure, { kind: "signin_missing" }>["command"]
        >().toEqualTypeOf<string | null>();
    });

    it("keeps a kind added later readable through its message", () => {
        const later = {
            kind: "quota_paused",
            message: "Paused by the vendor.",
            fallbackProviders: [],
        };
        expect(Value.Check(messageFailureSchema, later)).toBe(true);
        expect(isKnownMessageFailure(later)).toBe(false);
    });

    it("rejects a known kind missing its typed fields", () => {
        const { resetsAt: _, ...withoutReset } = failures[1] as Extract<
            MessageFailure,
            { kind: "usage_limit" }
        >;
        expect(Value.Check(messageFailureSchema, { ...withoutReset, kind: "usage_limit" })).toBe(
            // Readable as an unknown-shaped failure, never as a usage_limit with a guessed reset.
            true,
        );
        expect(
            Value.Check(messageFailureSchema, { kind: "usage_limit", fallbackProviders: [] }),
        ).toBe(false);
    });

    it.each([
        { kind: "usage_limit", message: "Usage reached.", fallbackProviders: [] },
        { kind: "usage_limit", message: "Usage reached.", fallbackProviders: [], provider: claude },
        {
            kind: "signin_missing",
            message: "Sign in.",
            fallbackProviders: [],
            product: null,
            command: null,
        },
        { kind: "context_too_long", message: "Too long.", fallbackProviders: [] },
    ])("never narrows a malformed $kind to its known type", (failure) => {
        expect(Value.Check(messageFailureSchema, failure)).toBe(true);
        expect(isKnownMessageFailure(failure)).toBe(false);
    });

    it("narrows every well-formed known kind", () => {
        for (const failure of failures) expect(isKnownMessageFailure(failure)).toBe(true);
    });

    it.each([
        { action: "retried", at: 2 },
        { action: "switched", at: 2, providerId: "codex", modelId: "openai/gpt-6.1-sol" },
        { action: "dismissed", at: 2 },
    ])("records resolution $action", (resolution) => {
        expect(Value.Check(messageFailureResolutionSchema, resolution)).toBe(true);
        expect(Value.Check(messageFailureSchema, { ...failures[0], resolution })).toBe(true);
    });

    it("reports a live retry on the agent", () => {
        expectTypeOf<AgentRetrying>().toEqualTypeOf<{
            attempt: number;
            maxAttempts: number;
            kind: string;
            vendorName: string;
        }>();
        expect(
            Value.Check(agentRetryingSchema, {
                attempt: 3,
                maxAttempts: 10,
                kind: "provider_unavailable",
                vendorName: "Claude",
            }),
        ).toBe(true);
        expect(
            Value.Check(agentRetryingSchema, {
                attempt: 0,
                maxAttempts: 10,
                kind: "network",
                vendorName: "Claude",
            }),
        ).toBe(false);
    });

    it("posts retry and switch actions to the failed message", async () => {
        const calls: { url: string; body: unknown }[] = [];
        const response = {
            agent: {},
            message: {},
            cursor: "c",
        } as unknown as FailureResolutionResponse;
        const fetch: typeof globalThis.fetch = async (input, init) => {
            calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            return Response.json(response);
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        await client.retryFailedTurn("agent", "message");
        await client.switchAndContinue("agent", "message", {
            providerId: "claude_work",
            modelId: "anthropic/opus-5-5",
        });
        expect(calls).toEqual([
            { url: "http://agent.local/v0/agents/agent/messages/message/retry", body: {} },
            {
                url: "http://agent.local/v0/agents/agent/messages/message/switch",
                body: { providerId: "claude_work", modelId: "anthropic/opus-5-5" },
            },
        ]);
    });
});
