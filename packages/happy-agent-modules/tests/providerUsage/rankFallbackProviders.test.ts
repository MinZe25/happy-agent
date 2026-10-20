import type { AgentModel } from "@slopus/happy-agent-base";
import type { ProviderUsage } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";

import {
    FALLBACK_READING_MAX_AGE_MS,
    rankFallbackProviders,
    type FallbackAccount,
} from "../../sources/providerUsage/impl/rankFallbackProviders.js";

const now = 1_000_000_000;
const model = (providerId: string, id: string): AgentModel => ({
    providerId,
    id,
    name: id,
    effortLevels: ["medium"],
    defaultEffort: "medium",
});
const window = (usedPercent: number) => ({
    usedPercent,
    resetsAt: null,
    startsAt: null,
    durationMs: null,
});
const usage = (
    providerId: string,
    windows: Partial<ProviderUsage["windows"]>,
    exhausted = false,
): ProviderUsage => ({
    providerId,
    vendor: "claude",
    capturedAt: now,
    planName: null,
    exhausted,
    windows: { fiveHour: null, weekly: null, monthly: null, ...windows },
    credits: null,
});
const account = (
    providerId: string,
    type: string,
    reading: ProviderUsage | null,
    fields: Partial<FallbackAccount> = {},
): FallbackAccount => ({
    providerId,
    type,
    label: providerId,
    offered: true,
    usage: reading,
    refreshedAt: now - 60_000,
    ...fields,
});

describe("ranking fallback providers", () => {
    it("orders same model, then same family, then other providers, by usage", () => {
        const ranked = rankFallbackProviders({
            failedProviderId: "claude",
            failedModelId: "anthropic/opus-5-5",
            failedType: "claude",
            models: [
                model("claude", "anthropic/opus-5-5"),
                model("claude_work", "anthropic/opus-5-5"),
                model("claude_extra", "anthropic/opus-5-5"),
                model("claude_old", "anthropic/sonnet-5"),
                model("codex", "openai/gpt-6.1-sol"),
                model("codex", "openai/gpt-6-luna"),
            ],
            accounts: [
                account("claude", "claude", usage("claude", { weekly: window(100) }, true)),
                account("claude_work", "claude", usage("claude_work", { weekly: window(60) })),
                account("claude_extra", "claude", usage("claude_extra", { weekly: window(12) })),
                account("claude_old", "claude", usage("claude_old", { fiveHour: window(5) })),
                account("codex", "codex", usage("codex", { monthly: window(40) })),
            ],
            now,
        });
        expect(ranked).toEqual([
            {
                providerId: "claude_extra",
                providerLabel: "claude_extra",
                modelId: "anthropic/opus-5-5",
                usedPercent: 12,
                usageWindow: "weekly",
                group: "same_model",
            },
            expect.objectContaining({ providerId: "claude_work", group: "same_model" }),
            {
                providerId: "claude_old",
                providerLabel: "claude_old",
                modelId: "anthropic/sonnet-5",
                usedPercent: 5,
                usageWindow: "5h",
                group: "same_family",
            },
            {
                providerId: "codex",
                providerLabel: "codex",
                modelId: "openai/gpt-6.1-sol",
                usedPercent: 40,
                usageWindow: "monthly",
                group: "other_provider",
            },
        ]);
    });

    it.each([
        ["an exhausted account", account("spent", "claude", usage("spent", {}, true))],
        ["an account without a reading", account("unread", "claude", null)],
        [
            "a stale reading",
            account("stale", "claude", usage("stale", {}), {
                refreshedAt: now - FALLBACK_READING_MAX_AGE_MS - 1,
            }),
        ],
        [
            "an account that is not offered",
            account("hidden", "claude", usage("hidden", {}), { offered: false }),
        ],
    ])("never lists %s", (_name, candidate) => {
        expect(
            rankFallbackProviders({
                failedProviderId: "claude",
                failedModelId: "anthropic/opus-5-5",
                failedType: "claude",
                models: [model(candidate.providerId, "anthropic/opus-5-5")],
                accounts: [candidate],
                now,
            }),
        ).toEqual([]);
    });

    it("keeps an account without usage windows with a null percentage", () => {
        expect(
            rankFallbackProviders({
                failedProviderId: "claude",
                failedModelId: "anthropic/opus-5-5",
                failedType: "claude",
                models: [model("plain", "anthropic/opus-5-5")],
                accounts: [account("plain", "claude", usage("plain", {}))],
                now,
            }),
        ).toEqual([expect.objectContaining({ usedPercent: null, usageWindow: null })]);
    });

    it("lists at most sixteen", () => {
        const ids = Array.from({ length: 20 }, (_, index) => `account_${index}`);
        expect(
            rankFallbackProviders({
                failedProviderId: "claude",
                failedModelId: "anthropic/opus-5-5",
                failedType: "claude",
                models: ids.map((id) => model(id, "anthropic/opus-5-5")),
                accounts: ids.map((id) => account(id, "claude", usage(id, {}))),
                now,
            }),
        ).toHaveLength(16);
    });
});
