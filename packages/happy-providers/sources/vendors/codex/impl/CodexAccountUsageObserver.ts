import type { ProviderUsage } from "@/core/ProviderUsage.js";
import {
    codexUsageFromRateLimitEvent,
    codexUsageFromRateLimitHeaders,
} from "@/vendors/codex/codexUsageFromRateLimits.js";

/**
 * Hands on what the ChatGPT backend says about the account while it answers.
 *
 * WebSocket responses open with a `codex.rate_limits` event and SSE responses carry the same
 * windows as headers, so every turn measures the account without asking the usage endpoint.
 * Only a ChatGPT login has such an account; API-key and Bedrock traffic is never reported.
 * Reporting is bookkeeping beside the run, so a listener that throws cannot break it.
 */
export class CodexAccountUsageObserver {
    readonly #report: ((usage: ProviderUsage) => void) | undefined;
    readonly #enabled: () => boolean;

    constructor(report: ((usage: ProviderUsage) => void) | undefined, enabled: () => boolean) {
        this.#report = report;
        this.#enabled = enabled;
    }

    observe(event: unknown): void {
        if (this.#report === undefined || !this.#enabled()) return;
        this.#deliver(codexUsageFromRateLimitEvent(event, this.#context()));
    }

    observeHeaders(headers: Headers): void {
        if (this.#report === undefined || !this.#enabled()) return;
        this.#deliver(codexUsageFromRateLimitHeaders(headers, this.#context()));
    }

    #context(): { capturedAt: number; providerId: string } {
        return { capturedAt: Date.now(), providerId: "codex" };
    }

    #deliver(usage: ProviderUsage | null): void {
        if (usage === null) return;
        try {
            this.#report?.(usage);
        } catch {
            // A usage listener never decides whether inference continues.
        }
    }
}
