import type { ProviderUsage, ProviderUsageCredits } from "@/core/ProviderUsage.js";
import { ProviderUsageRequestError } from "@/core/ProviderUsageRequestError.js";
import {
    epochMsFromIso,
    optionalResponseJson,
    providerPlanName,
    providerUsageWindow,
    usagePercent,
} from "@/core/providerUsageValues.js";
import {
    readClaudeCodeOAuthCredential,
    type ClaudeCodeOAuthCredential,
} from "@/vendors/claude/impl/auth.js";
import { parseClaudeRateLimitHeaders } from "@/vendors/claude/parseClaudeRateLimitHeaders.js";

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The cheapest model that still reports the account-wide unified limits. The
 * limits are not per-model, so probing with anything larger buys nothing.
 */
const PROBE_MODEL = "claude-haiku-4-5-20251001";

export interface FetchClaudeProviderUsageOptions {
    baseUrl?: string;
    configDir?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: () => number;
    oauthToken?: string;
    /**
     * Called when the OAuth usage endpoint refused this account: `403` or `404` when the token
     * cannot read it at all, `429` with the provider's retry instant when it is throttled.
     */
    onUsageEndpointRefused?: (refusal: ClaudeUsageEndpointRefusal) => void;
    probeModel?: string;
    providerId?: string;
    timeoutMs?: number;
    /**
     * Whether to ask the OAuth usage endpoint before measuring the inference headers. By default
     * a stored login is asked unless its grant lacks `user:profile`, a `CLAUDE_CODE_OAUTH_TOKEN`
     * is never asked, and an explicit `oauthToken` is asked.
     */
    usageEndpoint?: boolean;
    userAgent?: string;
}

/** Why the OAuth usage endpoint did not answer for an account. */
export interface ClaudeUsageEndpointRefusal {
    status: number;
    /** Epoch milliseconds before which the endpoint asked not to be called again. */
    retryAt?: number;
}

/** The OAuth scope the usage endpoint requires; only a full `claude auth login` grants it. */
const PROFILE_SCOPE = "user:profile";

/**
 * Reads one Claude account's usage.
 *
 * The OAuth usage endpoint is richer — it carries the plan, the scoped limits,
 * and extra-usage credits — but it requires the `user:profile` scope that only
 * a full `claude auth login` grants, and it is itself rate limited. Tokens from
 * `claude setup-token` are inference-only and never satisfy it, so they are not
 * sent there at all.
 *
 * Every other case measures the unified rate-limit headers on a one-token
 * inference response: an inference-only token, an endpoint that refused the
 * token, and an endpoint that throttled us. A throttled endpoint still reports
 * its retry boundary through `onUsageEndpointRefused`, and when the fallback
 * cannot measure the account either the endpoint's own error is surfaced so the
 * daemon can retain its cached reading and honor that boundary.
 */
export async function fetchClaudeProviderUsage(
    options: FetchClaudeProviderUsageOptions = {},
): Promise<ProviderUsage | null> {
    const credential =
        options.oauthToken === undefined ? await readClaudeCredential(options) : undefined;
    const token = options.oauthToken ?? credential?.accessToken;
    if (token === undefined) return null;
    const askEndpoint =
        options.usageEndpoint ??
        (credential === undefined ||
            (credential.source === "login" &&
                (credential.scopes === undefined || credential.scopes.includes(PROFILE_SCOPE))));
    if (!askEndpoint) return await probeRateLimitHeaders(token, options);
    try {
        const usage = await fetchFromUsageEndpoint(token, options);
        if (usage !== null) return usage;
    } catch (error: unknown) {
        if (!(error instanceof ProviderUsageRequestError) || error.status !== 429) throw error;
        options.onUsageEndpointRefused?.({
            status: error.status,
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        });
        // A throttled endpoint is no reason to keep showing an old reading: the inference
        // headers answer the same question and are not subject to that limit.
        const measured = await probeRateLimitHeaders(token, options);
        if (measured !== null) return measured;
        throw error;
    }
    return await probeRateLimitHeaders(token, options);
}

async function fetchFromUsageEndpoint(
    token: string,
    options: FetchClaudeProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const now = options.now ?? Date.now;
    const baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/u, "");
    const doFetch = options.fetch ?? fetch;
    const request = (path: string): Promise<Response> =>
        doFetch(`${baseUrl}${path}`, {
            method: "GET",
            headers: claudeHeaders(token, options),
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });

    const [usage, profile] = await Promise.all([
        request("/api/oauth/usage"),
        // The plan name lives on the profile; losing it must not lose usage.
        request("/api/oauth/profile").catch(() => null),
    ]);
    // An inference-only setup token cannot read account metadata, but it can
    // still report the unified limits attached to an inference response.
    if (usage.status === 403 || usage.status === 404) {
        options.onUsageEndpointRefused?.({ status: usage.status });
        return null;
    }
    if (!usage.ok) throw providerUsageResponseError(usage, now());
    const profilePayload = await optionalResponseJson(profile);

    return parseClaudeProviderUsage(await usage.json(), {
        capturedAt: now(),
        providerId: options.providerId ?? "claude",
        profile: profilePayload,
    });
}

function providerUsageResponseError(
    response: Response,
    capturedAt: number,
): ProviderUsageRequestError {
    const retryAt = retryAtFromHeader(response.headers.get("retry-after"), capturedAt);
    const retryText =
        retryAt === undefined
            ? ""
            : ` Retry after ${Math.max(0, Math.ceil((retryAt - capturedAt) / 1_000))} seconds.`;
    return new ProviderUsageRequestError(
        `Claude usage returned HTTP ${response.status}.${retryText}`,
        {
            ...(retryAt === undefined ? {} : { retryAt }),
            status: response.status,
        },
    );
}

function retryAtFromHeader(value: string | null, capturedAt: number): number | undefined {
    if (value === null) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return capturedAt + Math.ceil(seconds * 1_000);
    }
    const date = Date.parse(value);
    return Number.isFinite(date) && date >= capturedAt ? date : undefined;
}

/**
 * Measures the account with the smallest possible real request. The reply is
 * discarded; only the rate-limit headers matter. One output token stays far
 * below the resolution the limits are reported at, so the probe does not
 * meaningfully consume what it is measuring.
 */
async function probeRateLimitHeaders(
    token: string,
    options: FetchClaudeProviderUsageOptions,
): Promise<ProviderUsage | null> {
    const now = options.now ?? Date.now;
    const baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/u, "");
    const response = await (options.fetch ?? fetch)(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...claudeHeaders(token, options), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
            model: options.probeModel ?? PROBE_MODEL,
            max_tokens: 1,
            system: [
                { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
            ],
            messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    // A refusal can still carry authoritative headers, and a rejected account
    // is exactly what the caller needs to learn.
    const capturedAt = now();
    const usage = parseClaudeRateLimitHeaders(response.headers, {
        capturedAt,
        providerId: options.providerId ?? "claude",
    });
    if (usage !== null) return usage;
    if (!response.ok) throw providerUsageResponseError(response, capturedAt);
    return null;
}

function claudeHeaders(
    token: string,
    options: FetchClaudeProviderUsageOptions,
): Record<string, string> {
    return {
        authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "content-type": "application/json",
        "user-agent": options.userAgent ?? "claude-cli/2.0.0 (external, cli)",
    };
}

function readClaudeCredential(
    options: FetchClaudeProviderUsageOptions,
): Promise<ClaudeCodeOAuthCredential | undefined> {
    const env: NodeJS.ProcessEnv = {
        ...(options.env ?? process.env),
        ...(options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: options.configDir }),
    };
    return readClaudeCodeOAuthCredential({ env });
}

interface ClaudeRateLimitPayload {
    resets_at?: unknown;
    utilization?: unknown;
}

interface ClaudeLimitPayload {
    group?: unknown;
    is_active?: unknown;
    kind?: unknown;
    percent?: unknown;
    resets_at?: unknown;
    severity?: unknown;
    scope?: {
        model?: { display_name?: unknown } | null;
    } | null;
}

interface ClaudeUsagePayload {
    extra_usage?: {
        is_enabled?: unknown;
        monthly_limit?: unknown;
        used_credits?: unknown;
        utilization?: unknown;
    } | null;
    five_hour?: ClaudeRateLimitPayload | null;
    limits?: readonly ClaudeLimitPayload[] | null;
    seven_day?: ClaudeRateLimitPayload | null;
    seven_day_fable?: ClaudeRateLimitPayload | null;
    subscription_type?: unknown;
}

interface ClaudeProfilePayload {
    account?: { has_claude_max?: unknown; has_claude_pro?: unknown } | null;
}

export function parseClaudeProviderUsage(
    payload: unknown,
    context: { capturedAt: number; providerId: string; profile?: unknown },
): ProviderUsage {
    const body = (payload ?? {}) as ClaudeUsagePayload;
    const credits = parseClaudeCredits(body.extra_usage);
    return {
        providerId: context.providerId,
        vendor: "claude",
        capturedAt: context.capturedAt,
        planName:
            providerPlanName(body.subscription_type) ?? claudePlanFromProfile(context.profile),
        exhausted: isClaudeExhausted(body) && credits?.available !== true,
        windows: {
            fiveHour: parseClaudeWindow(body.five_hour, 5 * 60 * 60 * 1_000),
            weekly: parseClaudeWindow(body.seven_day, 7 * 24 * 60 * 60 * 1_000),
            monthly: null,
            fableWeekly: parseClaudeFableWeekly(body),
        },
        credits,
    };
}

function claudePlanFromProfile(profile: unknown): string | null {
    const account = (profile as ClaudeProfilePayload | null)?.account;
    if (account?.has_claude_max === true) return "Max";
    if (account?.has_claude_pro === true) return "Pro";
    return null;
}

function parseClaudeFableWeekly(body: ClaudeUsagePayload): ProviderUsage["windows"]["fiveHour"] {
    const named = parseClaudeWindow(body.seven_day_fable, 7 * 24 * 60 * 60 * 1_000);
    if (named !== null) return named;
    for (const limit of body.limits ?? []) {
        if (limit.kind !== "weekly_scoped") continue;
        const name = limit.scope?.model?.display_name;
        if (typeof name !== "string" || name.trim().toLowerCase() !== "fable") continue;
        const resetsAt = epochMsFromIso(limit.resets_at);
        return providerUsageWindow({
            usedPercent: limit.percent,
            resetsAt,
            startsAt: resetsAt === null ? null : resetsAt - 7 * 24 * 60 * 60 * 1_000,
            durationMs: 7 * 24 * 60 * 60 * 1_000,
        });
    }
    return null;
}

function parseClaudeWindow(
    payload: ClaudeRateLimitPayload | null | undefined,
    durationMs: number,
): ProviderUsage["windows"]["fiveHour"] {
    const resetsAt = epochMsFromIso(payload?.resets_at);
    return providerUsageWindow({
        usedPercent: payload?.utilization,
        resetsAt,
        startsAt: resetsAt === null ? null : resetsAt - durationMs,
        durationMs,
    });
}

/**
 * An account is finished when any limit it is actually subject to has run
 * out. Anthropic marks that with a `critical` severity on an active limit.
 */
function isClaudeExhausted(body: ClaudeUsagePayload): boolean {
    for (const limit of body.limits ?? []) {
        if (limit.is_active === true && limit.severity === "critical") return true;
    }
    const fiveHour = usagePercent(body.five_hour?.utilization);
    const sevenDay = usagePercent(body.seven_day?.utilization);
    return (fiveHour !== null && fiveHour >= 100) || (sevenDay !== null && sevenDay >= 100);
}

function parseClaudeCredits(
    payload: ClaudeUsagePayload["extra_usage"],
): ProviderUsageCredits | null {
    if (payload == null) return null;
    const enabled = payload.is_enabled === true;
    const utilization = usagePercent(payload.utilization);
    return {
        available: enabled && (utilization === null || utilization < 100),
        remainingCents: null,
        unlimited: false,
        usedPercent: utilization,
    };
}
