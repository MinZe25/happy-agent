import type { AgentModel } from "@slopus/happy-agent-base";
import type { KnownFallbackGroup, MessageFailureFallback } from "@slopus/happy-agent-client";
import type { ProviderUsage, ProviderUsageWindow } from "@slopus/happy-providers";

/** A reading older than this cannot vouch that an account still has usage left. */
export const FALLBACK_READING_MAX_AGE_MS = 15 * 60_000;
const MAX_FALLBACKS = 16;
const GROUP_ORDER: readonly KnownFallbackGroup[] = ["same_model", "same_family", "other_provider"];

export interface FallbackAccount {
    readonly providerId: string;
    /** The provider family, such as `claude`. */
    readonly type: string | null;
    readonly label: string;
    /** Smart aliases, hidden accounts, and accounts that need a sign-in are never offered. */
    readonly offered: boolean;
    readonly usage: ProviderUsage | null;
    readonly refreshedAt: number | null;
}

/**
 * The usable alternatives to a failed provider and model, ranked so every client agrees: the same
 * model on other accounts, then the same family's default model, then other providers' default
 * models, lowest usage first within each group. An account qualifies only when it is enabled,
 * serves a compatible model, and its latest reading is fresh and not exhausted. A provider's
 * default model is the first one its catalog lists.
 */
export function rankFallbackProviders(input: {
    readonly failedProviderId: string;
    readonly failedModelId: string;
    readonly failedType: string | null;
    readonly models: readonly AgentModel[];
    readonly accounts: readonly FallbackAccount[];
    readonly now: number;
}): MessageFailureFallback[] {
    const accounts = new Map(input.accounts.map((account) => [account.providerId, account]));
    const byProvider = new Map<string, AgentModel[]>();
    for (const model of input.models) {
        const list = byProvider.get(model.providerId) ?? [];
        list.push(model);
        byProvider.set(model.providerId, list);
    }
    const ranked: (MessageFailureFallback & { readonly order: number })[] = [];
    for (const [providerId, models] of byProvider) {
        const account = accounts.get(providerId);
        if (providerId === input.failedProviderId || account === undefined || !account.offered)
            continue;
        const usage = account.usage;
        if (
            usage === null ||
            usage.exhausted ||
            account.refreshedAt === null ||
            input.now - account.refreshedAt > FALLBACK_READING_MAX_AGE_MS
        )
            continue;
        const sameModel = models.find((model) => model.id === input.failedModelId);
        const group: KnownFallbackGroup =
            sameModel !== undefined
                ? "same_model"
                : account.type !== null && account.type === input.failedType
                  ? "same_family"
                  : "other_provider";
        const window = usageWindow(usage);
        ranked.push({
            providerId,
            providerLabel: account.label,
            modelId: (sameModel ?? models[0]!).id,
            usedPercent: window?.usedPercent ?? null,
            usageWindow: window?.name ?? null,
            group,
            order: GROUP_ORDER.indexOf(group),
        });
    }
    return ranked
        .sort(
            (left, right) =>
                left.order - right.order ||
                (left.usedPercent ?? 101) - (right.usedPercent ?? 101) ||
                left.providerId.localeCompare(right.providerId),
        )
        .slice(0, MAX_FALLBACKS)
        .map(({ order: _order, ...fallback }) => fallback);
}

/** The weekly window when the vendor reports one, otherwise the window the percentage comes from. */
function usageWindow(
    usage: ProviderUsage,
): { readonly name: string; readonly usedPercent: number } | undefined {
    const candidates: readonly [string, ProviderUsageWindow | null | undefined][] = [
        ["weekly", usage.windows.weekly],
        ["5h", usage.windows.fiveHour],
        ["monthly", usage.windows.monthly],
    ];
    for (const [name, window] of candidates) {
        if (window !== null && window !== undefined)
            return { name, usedPercent: Math.min(100, Math.max(0, window.usedPercent)) };
    }
    return undefined;
}
