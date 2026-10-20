import { Value } from "@sinclair/typebox/value";
import {
    isKnownMessageFailure,
    messageFailureSchema,
    type MessageFailureFallback,
} from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import type { ProviderExecutionAttempt } from "../../sources/config/index.js";
import { messageFailure, relativeTime } from "../../sources/history/impl/messageFailure.js";

const now = Date.UTC(2026, 9, 20, 12, 0, 0);
const provider = { id: "claude", type: "claude", vendorName: "Claude", label: "claude" };
const fallback: MessageFailureFallback = {
    providerId: "claude_work",
    providerLabel: "claude_work",
    modelId: "anthropic/opus-5-5",
    usedPercent: 38,
    usageWindow: "weekly",
    group: "same_model",
};
const attempt = (fields: Partial<ProviderExecutionAttempt>): ProviderExecutionAttempt => ({
    mode: {
        providerId: "claude",
        modelId: "anthropic/opus-5-5",
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto",
    },
    credentialSource: null,
    ...fields,
});
const build = (fields: Partial<Parameters<typeof messageFailure>[0]>) =>
    messageFailure({
        text: "Upstream said no.",
        attempt: undefined,
        unavailable: undefined,
        provider,
        fallbackProviders: [fallback],
        now,
        ...fields,
    });

describe("a failed turn's typed failure", () => {
    it.each([
        [
            "authentication_failed",
            {
                kind: "signin_missing",
                message: "Claude Code isn't signed in. Run claude auth login, then retry.",
                product: "Claude Code",
                command: "claude auth login",
            },
        ],
        [
            "rate_limit",
            { kind: "rate_limited", message: "Claude is rate-limited. Try again in a minute." },
        ],
        [
            "server_overloaded",
            {
                kind: "provider_unavailable",
                message: "Claude is overloaded right now. Try again in a moment.",
            },
        ],
        ["internal_server_error", { kind: "provider_unavailable" }],
        ["empty_response", { kind: "provider_unavailable" }],
        [
            "network",
            {
                kind: "network",
                message: "Couldn't reach Claude. Check your connection, then retry.",
            },
        ],
        [
            "unclassified",
            {
                kind: "internal",
                message: "Upstream said no.",
                detail: "Upstream said no.",
            },
        ],
    ] as const)("maps %s to its kind", (errorCode, expected) => {
        const failure = build({
            attempt: attempt({
                errorCode,
                signIn: { product: "Claude Code", command: "claude auth login" },
            }),
        });
        expect(failure).toMatchObject({ ...expected, fallbackProviders: [fallback] });
        expect(Value.Check(messageFailureSchema, failure)).toBe(true);
        expect(isKnownMessageFailure(failure)).toBe(true);
    });

    it("names the reset as a duration, never a clock time", () => {
        const resetsAt = now + 2 * 60 * 60_000;
        const failure = build({ attempt: attempt({ errorCode: "out_of_tokens", resetsAt }) });
        expect(failure).toMatchObject({
            kind: "usage_limit",
            message: "Claude usage limit reached. It resets in about 2 hours.",
            resetsAt,
        });
        expect(failure.message).not.toMatch(/\d{1,2}:\d{2}|UTC|GMT|AM|PM|T\d{2}/u);
        expect(isKnownMessageFailure(failure)).toBe(true);
    });

    it("leaves an unknown reset out of the sentence", () => {
        expect(build({ attempt: attempt({ errorCode: "out_of_tokens" }) })).toMatchObject({
            message: "Claude usage limit reached.",
            resetsAt: null,
        });
    });

    it("says a custom source needs its settings checked", () => {
        expect(
            build({
                attempt: attempt({
                    errorCode: "authentication_failed",
                    signIn: { product: null, command: null },
                }),
            }),
        ).toMatchObject({
            kind: "signin_missing",
            message: "claude has no credentials. Check its settings, then retry.",
            product: null,
            command: null,
        });
    });

    it("uses configuration's missing credential when no attempt exists", () => {
        const failure = build({
            unavailable: {
                providerId: "claude",
                signIn: { product: "Grok", command: "grok login" },
                error: {
                    code: "credentials_unavailable",
                    mode: null,
                    credentialSource: null,
                    recovery: { steps: ["Sign in."], actions: ["ask_chief"] },
                },
            },
        });
        expect(failure).toMatchObject({ kind: "signin_missing", command: "grok login" });
    });

    it("keeps only a bounded first line of an unclassified error", () => {
        const failure = build({ text: `\n${"x".repeat(900)}\nsecond line` });
        expect(failure.kind).toBe("internal");
        expect(failure.message.length).toBeLessThanOrEqual(512);
        expect(Value.Check(messageFailureSchema, failure)).toBe(true);
        expect(JSON.stringify(failure)).not.toContain("second line");
    });

    it.each([
        [30_000, "in under a minute"],
        [60_000, "in about 1 minute"],
        [45 * 60_000, "in about 45 minutes"],
        [90 * 60_000, "in about 2 hours"],
        [47 * 60 * 60_000, "in about 47 hours"],
        [3 * 24 * 60 * 60_000, "in about 3 days"],
    ])("describes a reset %d ms away as %s", (delta, text) => {
        expect(relativeTime(now + delta, now)).toBe(text);
    });
});
