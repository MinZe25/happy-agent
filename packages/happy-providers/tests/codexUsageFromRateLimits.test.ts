import { describe, expect, it } from "vitest";

import {
    codexUsageFromRateLimitEvent,
    codexUsageFromRateLimitHeaders,
} from "@/vendors/codex/codexUsageFromRateLimits.js";
import { CodexAccountUsageObserver } from "@/vendors/codex/impl/CodexAccountUsageObserver.js";

const context = { capturedAt: 1_000, providerId: "codex" };

// The ChatGPT backend opens every WebSocket response with this event (see the recorded
// `codex.rate_limits` event types in the websocket fixtures). The fields follow upstream Codex's
// `RateLimitEvent`, `RateLimitEventWindow`, and `RateLimitEventCredits`.
const rateLimitEvent = {
    type: "codex.rate_limits",
    plan_type: "pro",
    rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 32, window_minutes: 300, reset_at: 1_755_412_000 },
        secondary: { used_percent: 16, window_minutes: 10_080, reset_at: 1_755_900_000 },
    },
    credits: { has_credits: true, unlimited: false, balance: "12.50" },
    metered_limit_name: "codex",
};

describe("Codex in-band account usage", () => {
    it("reads both windows from the WebSocket rate-limit event", () => {
        const usage = codexUsageFromRateLimitEvent(rateLimitEvent, context);

        expect(usage).toMatchObject({
            providerId: "codex",
            vendor: "codex",
            capturedAt: 1_000,
            planName: "Pro",
            exhausted: false,
            credits: { available: true, remainingCents: 1_250 },
        });
        expect(usage?.windows.fiveHour).toEqual({
            usedPercent: 32,
            resetsAt: 1_755_412_000_000,
            startsAt: 1_755_412_000_000 - 5 * 60 * 60 * 1_000,
            durationMs: 5 * 60 * 60 * 1_000,
        });
        expect(usage?.windows.weekly?.usedPercent).toBe(16);
        expect(usage?.windows.monthly).toBeNull();
    });

    it("ignores another metered limit and every other event", () => {
        expect(
            codexUsageFromRateLimitEvent(
                { ...rateLimitEvent, metered_limit_name: "codex_other" },
                context,
            ),
        ).toBeNull();
        expect(codexUsageFromRateLimitEvent({ type: "response.created" }, context)).toBeNull();
        expect(
            codexUsageFromRateLimitEvent(
                { type: "codex.rate_limits", rate_limits: null, credits: null },
                context,
            ),
        ).toBeNull();
    });

    it("marks a spent window exhausted unless credits keep the account working", () => {
        const spent = {
            ...rateLimitEvent,
            rate_limits: {
                primary: { used_percent: 100, window_minutes: 300, reset_at: 1_755_412_000 },
            },
        };

        expect(codexUsageFromRateLimitEvent({ ...spent, credits: null }, context)?.exhausted).toBe(
            true,
        );
        expect(codexUsageFromRateLimitEvent(spent, context)?.exhausted).toBe(false);
    });

    it("reads the same windows from SSE response headers", () => {
        const usage = codexUsageFromRateLimitHeaders(
            new Headers({
                "x-codex-primary-used-percent": "100.0",
                "x-codex-primary-window-minutes": "300",
                "x-codex-primary-reset-at": "1704069000",
                "x-codex-secondary-used-percent": "87.5",
                "x-codex-secondary-window-minutes": "10080",
                "x-codex-secondary-reset-at": "1704500000",
                "x-codex-credits-has-credits": "false",
                "x-codex-credits-unlimited": "false",
            }),
            context,
        );

        expect(usage?.windows.fiveHour?.usedPercent).toBe(100);
        expect(usage?.windows.fiveHour?.resetsAt).toBe(1_704_069_000_000);
        expect(usage?.windows.weekly?.usedPercent).toBe(87.5);
        expect(usage?.exhausted).toBe(true);
    });

    it("reports nothing for a response without Codex account headers", () => {
        expect(
            codexUsageFromRateLimitHeaders(new Headers({ "x-request-id": "1" }), context),
        ).toBeNull();
    });

    it("reports only for a ChatGPT login and survives a listener that throws", () => {
        const reported: unknown[] = [];
        let chatgpt = false;
        const observer = new CodexAccountUsageObserver(
            (usage) => {
                reported.push(usage.windows.fiveHour?.usedPercent);
                throw new Error("listener failure");
            },
            () => chatgpt,
        );

        observer.observe(rateLimitEvent);
        chatgpt = true;
        expect(() => observer.observe(rateLimitEvent)).not.toThrow();

        expect(reported).toEqual([32]);
    });
});
