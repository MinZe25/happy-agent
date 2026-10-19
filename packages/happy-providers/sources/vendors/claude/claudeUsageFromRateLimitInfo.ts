import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type {
    ProviderUsage,
    ProviderUsageCredits,
    ProviderUsageWindow,
} from "@/core/ProviderUsage.js";
import { epochMsFromSeconds, providerUsageWindow } from "@/core/providerUsageValues.js";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * One window from the CLI's `unifiedWindows`, read from the
 * `anthropic-ratelimit-unified-*` headers of every response. `utilization` is
 * a fraction of the window that can run past 1; `resetsAt` is epoch seconds.
 */
const unifiedWindowSchema = Type.Object({
    utilization: Type.Number(),
    resetsAt: Type.Number(),
});

/**
 * `rate_limit_info.unifiedWindows` is marked internal and absent from the SDK's
 * published types, so it is checked here instead of trusted. A window that does
 * not match is ignored rather than invalidating the rest of the report.
 */
const unifiedWindowsSchema = Type.Object({
    five_hour: Type.Optional(Type.Unknown()),
    seven_day: Type.Optional(Type.Unknown()),
});

type UnifiedWindow = Static<typeof unifiedWindowSchema>;

/**
 * Reads the rate-limit report the Claude SDK already emits during inference.
 *
 * This is the same account-wide unified limiter the response headers carry, so
 * every ordinary run tells us where the account stands and nothing has to ask
 * the vendor a second time. The CLI tracks the five-hour and seven-day windows
 * on every response and reports them in `unifiedWindows` whenever either one's
 * rounded percentage or reset moves. The top-level fields describe only the
 * window that currently constrains the account, and are filled only near or
 * past a limit. An unreported window is null and the caller keeps whatever it
 * already knew.
 *
 * Returns null when the report says nothing worth recording.
 */
export function claudeUsageFromRateLimitInfo(
    info: SDKRateLimitInfo,
    context: { capturedAt: number; providerId: string },
): ProviderUsage | null {
    // Overage and other model-scoped windows stay unread, except Fable's
    // weekly allowance, which is its own meter the account actually spends.
    const rateLimitType: string | undefined = info.rateLimitType;
    const key =
        rateLimitType === "five_hour"
            ? "fiveHour"
            : rateLimitType === "seven_day"
              ? "weekly"
              : rateLimitType === "seven_day_fable"
                ? "fableWeekly"
                : null;
    const resetsAt = epochMsFromSeconds(info.resetsAt);
    const durationMs = key === "fiveHour" ? FIVE_HOUR_MS : SEVEN_DAY_MS;
    const window =
        key === null
            ? null
            : providerUsageWindow({
                  // The limiter reports a fraction of the limit, where the OAuth
                  // usage endpoint already reports a percentage.
                  usedPercent: info.utilization === undefined ? undefined : info.utilization * 100,
                  resetsAt,
                  startsAt: resetsAt === null ? null : resetsAt - durationMs,
                  durationMs,
              });
    const unified = unifiedWindows(info);
    const fiveHour = unified.fiveHour ?? (key === "fiveHour" ? window : null);
    const weekly = unified.weekly ?? (key === "weekly" ? window : null);
    const fableWeekly = key === "fableWeekly" ? window : null;
    const credits = parseOverageCredits(info);
    const rejected = info.status === "rejected";
    // An allowed account with no measured window has told us nothing new.
    if (
        fiveHour === null &&
        weekly === null &&
        fableWeekly === null &&
        credits === null &&
        !rejected
    ) {
        return null;
    }

    return {
        providerId: context.providerId,
        vendor: "claude",
        capturedAt: context.capturedAt,
        planName: null,
        exhausted: rejected && credits?.available !== true,
        windows: { fiveHour, weekly, monthly: null, fableWeekly },
        credits,
    };
}

function unifiedWindows(info: SDKRateLimitInfo): {
    fiveHour: ProviderUsageWindow | null;
    weekly: ProviderUsageWindow | null;
} {
    const value: unknown = (info as { unifiedWindows?: unknown }).unifiedWindows;
    if (!Value.Check(unifiedWindowsSchema, value)) return { fiveHour: null, weekly: null };
    return {
        fiveHour: unifiedWindow(value.five_hour, FIVE_HOUR_MS),
        weekly: unifiedWindow(value.seven_day, SEVEN_DAY_MS),
    };
}

function unifiedWindow(value: unknown, durationMs: number): ProviderUsageWindow | null {
    if (!Value.Check(unifiedWindowSchema, value)) return null;
    const window: UnifiedWindow = value;
    const resetsAt = epochMsFromSeconds(window.resetsAt);
    return providerUsageWindow({
        // Usage can legitimately run past a window's cap; the account has then
        // used all of it, which is as far as a percentage of the window goes.
        // Rounding to hundredths removes the noise of scaling a binary fraction.
        usedPercent: Math.min(100, Math.round(window.utilization * 10_000) / 100),
        resetsAt,
        startsAt: resetsAt === null ? null : resetsAt - durationMs,
        durationMs,
    });
}

/**
 * Overage is Anthropic's pay-past-the-limit credit. It is only spendable when
 * the account is actually allowed to use it.
 */
function parseOverageCredits(info: SDKRateLimitInfo): ProviderUsageCredits | null {
    if (info.overageStatus === undefined) return null;
    return {
        available: info.overageStatus !== "rejected",
        remainingCents: null,
        unlimited: false,
        usedPercent: null,
    };
}
