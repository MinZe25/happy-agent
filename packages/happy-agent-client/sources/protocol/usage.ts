/**
 * Usage: what was consumed, never summarized across models.
 *
 * Tokens from different models are not comparable quantities, so the breakdown
 * is always by provider and then by model; a client wanting a rollup computes
 * its own.
 */

import { type Static, Type } from "@sinclair/typebox";

import { Nullable } from "./common.js";
import { providerModelReferenceSchema } from "./daemon.js";

/** Token counts for one model. */
export interface ModelUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Provider key, then model ID, then the counts. */
export type UsageBreakdown = Record<string, Record<string, ModelUsage>>;

/** One normalized account-usage window reported by a provider. */
export const providerAccountUsageWindowSchema = Type.Object({
    usedPercent: Type.Number(),
    resetsAt: Nullable(Type.Number()),
    startsAt: Nullable(Type.Number()),
    durationMs: Nullable(Type.Number()),
    /** When this window itself was last measured, protocol 29 or newer. */
    capturedAt: Type.Optional(Type.Number()),
});
export type ProviderAccountUsageWindow = Static<typeof providerAccountUsageWindowSchema>;

/** Spendable balance reported alongside a provider's account limits. */
export const providerAccountUsageCreditsSchema = Type.Object({
    available: Type.Boolean(),
    remainingCents: Nullable(Type.Number()),
    unlimited: Type.Boolean(),
    usedPercent: Nullable(Type.Number()),
});
export type ProviderAccountUsageCredits = Static<typeof providerAccountUsageCreditsSchema>;

/** The complete latest normalized account-usage reading from one vendor. */
export const providerAccountUsageSchema = Type.Object({
    providerId: Type.String(),
    vendor: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("grok")]),
    capturedAt: Type.Number(),
    planName: Nullable(Type.String()),
    exhausted: Type.Boolean(),
    windows: Type.Object({
        fiveHour: Nullable(providerAccountUsageWindowSchema),
        weekly: Nullable(providerAccountUsageWindowSchema),
        monthly: Nullable(providerAccountUsageWindowSchema),
        /** Claude's separate weekly Fable allowance. Omitted or null when unreported. */
        fableWeekly: Type.Optional(Nullable(providerAccountUsageWindowSchema)),
    }),
    credits: Nullable(providerAccountUsageCreditsSchema),
});
export type ProviderAccountUsage = Static<typeof providerAccountUsageSchema>;

/**
 * Everything the daemon knows about reading one provider account, without its configuration.
 *
 * The refresh fields are optional only for compatibility with older daemons: a protocol-29 daemon
 * always sends them, so an entry without `refreshedAt` comes from a daemon that neither publishes
 * `provider.usage.updated` nor serves `POST /v0/usage/refresh`.
 */
export const providerAccountUsageStateSchema = Type.Object({
    providerId: Type.String(),
    /** The latest successful normalized reading, or `null` when none is available. */
    usage: Nullable(providerAccountUsageSchema),
    /** When the daemon last finished asking, successfully or not. */
    checkedAt: Nullable(Type.Number()),
    /** Why no reading is available at all. */
    error: Nullable(Type.String()),
    /** When the last successful reading arrived, from a poll or from inference. */
    refreshedAt: Type.Optional(Nullable(Type.Number())),
    /** Why the latest read failed, kept even while an older reading is shown. */
    refreshError: Type.Optional(Nullable(Type.String())),
    /** The instant before which the vendor asked not to be asked again. */
    retryAt: Type.Optional(Nullable(Type.Number())),
    /** Whether a read of this account is in flight. */
    refreshing: Type.Optional(Type.Boolean()),
});
export type ProviderAccountUsageState = Static<typeof providerAccountUsageStateSchema>;

/** One configured provider, its complete model catalog, and its latest account limits. */
export const providerUsageEntrySchema = Type.Composite([
    providerAccountUsageStateSchema,
    Type.Object({
        /** The canonical provider key from the effective configuration. */
        type: Type.String(),
        enabled: Type.Boolean(),
        /** The same complete model-reference list returned for this provider by `GET /v0/config`. */
        models: Type.Array(providerModelReferenceSchema),
    }),
]);
export type ProviderUsageEntry = Static<typeof providerUsageEntrySchema>;

/** `POST /v0/usage/refresh` request body, protocol 29 or newer. */
export const providerUsageRefreshRequestSchema = Type.Object(
    {
        /** The accounts to consider; every enabled account when omitted. */
        providerIds: Type.Optional(Type.Array(Type.String())),
        /** Read only accounts older than this; defaults to 300000 and is at least 60000. */
        olderThanMs: Type.Optional(Type.Number({ minimum: 0 })),
    },
    { additionalProperties: false },
);
export type ProviderUsageRefreshRequest = Static<typeof providerUsageRefreshRequestSchema>;

/** `POST /v0/usage/refresh` — `202`; the results arrive as `provider.usage.updated`. */
export const providerUsageRefreshResponseSchema = Type.Object({
    started: Type.Array(Type.String()),
});
export type ProviderUsageRefreshResponse = Static<typeof providerUsageRefreshResponseSchema>;

/** The latest exact provider measurement of one agent's active conversation context. */
export interface AgentContextUsage {
    approximate: boolean;
    contextTokens: number;
    /** The configured hard limit, or `null` for a custom model with no known limit. */
    contextWindow: number | null;
    modelId: string | null;
    providerId: string;
}

/** `GET /v0/agents/:agentId/usage` — the agent's whole life, subagents included. */
export interface AgentUsageResponse {
    /** The root agent's current context; descendant contexts are deliberately separate. */
    context: AgentContextUsage | null;
    usage: UsageBreakdown;
}

/** `GET /v0/usage` — rolling windows ending now. */
export interface DaemonUsageResponse {
    /** Optional only so this client remains compatible with older protocol-22 daemons. */
    providers?: ProviderUsageEntry[];
    hour: UsageBreakdown;
    day: UsageBreakdown;
    week: UsageBreakdown;
    month: UsageBreakdown;
}
