import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    fetchClaudeProviderUsage,
    parseClaudeProviderUsage,
} from "@/vendors/claude/fetchClaudeProviderUsage.js";
import { parseCodexProviderUsage } from "@/vendors/codex/fetchCodexProviderUsage.js";
import { fetchGrokProviderUsage } from "@/vendors/grok/fetchGrokProviderUsage.js";
import { GROK_OAUTH_SCOPE } from "@/vendors/grok/impl/auth.js";

const cleanups: (() => Promise<void>)[] = [];

const unifiedHeaders = {
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-7d-utilization": "0.61",
    "anthropic-ratelimit-unified-status": "allowed",
};

async function usageThrottleFixture(): Promise<{
    body: unknown;
    headers: Record<string, string>;
    status: number;
}> {
    return JSON.parse(
        await readFile(
            new URL("./vendors/fixtures/claude-usage-rate-limit-429.json", import.meta.url),
            "utf8",
        ),
    ) as { body: unknown; headers: Record<string, string>; status: number };
}

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("provider usage metadata", () => {
    it.each([
        {
            label: "workspace spend control",
            payload: {
                credits: { has_credits: true, unlimited: false },
                rate_limit: { allowed: true, limit_reached: false },
                spend_control: { reached: true },
            },
        },
        {
            label: "workspace credit depletion",
            payload: {
                credits: { has_credits: true, unlimited: false },
                rate_limit: { allowed: true, limit_reached: false },
                rate_limit_reached_type: { type: "workspace_member_credits_depleted" },
            },
        },
    ])("marks Codex exhausted for $label", ({ payload }) => {
        expect(
            parseCodexProviderUsage(payload, { capturedAt: 1_000, providerId: "codex" }).exhausted,
        ).toBe(true);
    });

    it("keeps valid Claude usage when the optional profile body is malformed", async () => {
        const usage = await fetchClaudeProviderUsage({
            oauthToken: "test-token",
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/api/oauth/usage") {
                    return Response.json({ five_hour: { utilization: 42 } });
                }
                if (path === "/api/oauth/profile") {
                    return new Response("{", { status: 200 });
                }
                throw new Error(`Unexpected request ${path}`);
            },
        });

        expect(usage?.windows.fiveHour?.usedPercent).toBe(42);
    });

    it("reads Claude's Fable weekly allowance from the scoped limits list", () => {
        const usage = parseClaudeProviderUsage(
            {
                five_hour: { utilization: 5, resets_at: "2026-08-24T09:09:59.000Z" },
                seven_day: { utilization: 89, resets_at: "2026-08-27T00:59:59.000Z" },
                limits: [
                    {
                        kind: "weekly_scoped",
                        percent: 100,
                        resets_at: "2026-08-27T00:59:59.000Z",
                        scope: { model: { display_name: "Fable" } },
                    },
                ],
            },
            { capturedAt: 1_000, providerId: "claude" },
        );

        expect(usage.windows.fiveHour?.usedPercent).toBe(5);
        expect(usage.windows.weekly?.usedPercent).toBe(89);
        expect(usage.windows.fableWeekly?.usedPercent).toBe(100);
        expect(usage.windows.fableWeekly?.resetsAt).toBe(Date.parse("2026-08-27T00:59:59.000Z"));
    });

    it("measures a throttled Claude account from inference headers instead", async () => {
        const paths: string[] = [];
        const refusals: unknown[] = [];
        const fixture = await usageThrottleFixture();
        const usage = await fetchClaudeProviderUsage({
            oauthToken: "test-token",
            now: () => 1_000,
            onUsageEndpointRefused: (refusal) => refusals.push(refusal),
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                paths.push(path);
                if (path === "/api/oauth/usage") {
                    return Response.json(fixture.body, {
                        status: fixture.status,
                        headers: fixture.headers,
                    });
                }
                if (path === "/api/oauth/profile") return Response.json({});
                if (path === "/v1/messages") {
                    return Response.json({}, { headers: unifiedHeaders });
                }
                throw new Error(`Unexpected request ${path}`);
            },
        });

        expect(usage?.windows.fiveHour?.usedPercent).toBe(25);
        expect(usage?.windows.weekly?.usedPercent).toBe(61);
        // The endpoint's own boundary is still reported, so it is not asked again too soon.
        expect(refusals).toEqual([{ status: 429, retryAt: 3_601_000 }]);
        expect(paths).toEqual(["/api/oauth/usage", "/api/oauth/profile", "/v1/messages"]);
    });

    it("surfaces Claude usage throttling when the fallback measures nothing", async () => {
        const fixture = await usageThrottleFixture();
        const request = fetchClaudeProviderUsage({
            oauthToken: "test-token",
            now: () => 1_000,
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/api/oauth/usage") {
                    return Response.json(fixture.body, {
                        status: fixture.status,
                        headers: fixture.headers,
                    });
                }
                if (path === "/api/oauth/profile") return Response.json({});
                if (path === "/v1/messages") return Response.json({});
                throw new Error(`Unexpected request ${path}`);
            },
        });

        await expect(request).rejects.toMatchObject({
            message: "Claude usage returned HTTP 429. Retry after 3600 seconds.",
            name: "ProviderUsageRequestError",
            retryAt: 3_601_000,
            status: 429,
        });
    });

    it("never asks the usage endpoint for a CLAUDE_CODE_OAUTH_TOKEN", async () => {
        const paths: string[] = [];
        const usage = await fetchClaudeProviderUsage({
            env: { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                paths.push(path);
                return Response.json({}, { headers: unifiedHeaders });
            },
        });

        expect(usage?.windows.fiveHour?.usedPercent).toBe(25);
        expect(paths).toEqual(["/v1/messages"]);
    });

    it("never asks the usage endpoint when told the token cannot read it", async () => {
        const paths: string[] = [];
        await fetchClaudeProviderUsage({
            oauthToken: "configured-token",
            usageEndpoint: false,
            fetch: async (input) => {
                paths.push(new URL(String(input)).pathname);
                return Response.json({}, { headers: unifiedHeaders });
            },
        });

        expect(paths).toEqual(["/v1/messages"]);
    });

    it.each([
        { label: "with", scopes: ["user:inference", "user:profile"], first: "/api/oauth/usage" },
        { label: "without", scopes: ["user:inference"], first: "/v1/messages" },
    ])("chooses the usage method for a login $label the profile scope", async (scenario) => {
        const directory = await mkdtemp(join(tmpdir(), "rig-claude-usage-"));
        cleanups.push(() => rm(directory, { force: true, recursive: true }));
        await writeFile(
            join(directory, ".credentials.json"),
            JSON.stringify({
                claudeAiOauth: { accessToken: "login-token", scopes: scenario.scopes },
            }),
        );
        const paths: string[] = [];
        const usage = await fetchClaudeProviderUsage({
            configDir: directory,
            env: { USER: "rig-test-user-without-keychain-item" },
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                paths.push(path);
                if (path === "/api/oauth/usage") {
                    return Response.json({ five_hour: { utilization: 42 } });
                }
                if (path === "/api/oauth/profile") return Response.json({});
                return Response.json({}, { headers: unifiedHeaders });
            },
        });

        expect(paths[0]).toBe(scenario.first);
        expect(usage?.windows.fiveHour?.usedPercent).toBe(
            scenario.first === "/v1/messages" ? 25 : 42,
        );
    });

    it("reports a Claude usage endpoint that refuses the token", async () => {
        const refusals: unknown[] = [];
        await fetchClaudeProviderUsage({
            oauthToken: "test-token",
            onUsageEndpointRefused: (refusal) => refusals.push(refusal),
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/api/oauth/usage") return new Response(null, { status: 403 });
                if (path === "/api/oauth/profile") return Response.json({});
                return Response.json({}, { headers: unifiedHeaders });
            },
        });

        expect(refusals).toEqual([{ status: 403 }]);
    });

    it("falls back to inference headers for a scoped Claude setup token", async () => {
        const usage = await fetchClaudeProviderUsage({
            oauthToken: "test-token",
            now: () => 1_000,
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/api/oauth/usage") return new Response(null, { status: 403 });
                if (path === "/api/oauth/profile") return Response.json({});
                if (path === "/v1/messages") {
                    return Response.json(
                        {},
                        {
                            headers: {
                                "anthropic-ratelimit-unified-5h-utilization": "0.25",
                                "anthropic-ratelimit-unified-status": "allowed",
                            },
                        },
                    );
                }
                throw new Error(`Unexpected request ${path}`);
            },
        });

        expect(usage?.windows.fiveHour?.usedPercent).toBe(25);
    });

    it("keeps valid Grok billing when the optional user body is malformed", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-grok-usage-"));
        cleanups.push(() => rm(directory, { force: true, recursive: true }));
        const authFile = join(directory, "auth.json");
        await writeFile(
            authFile,
            JSON.stringify({
                [GROK_OAUTH_SCOPE]: {
                    expires_at: "2999-01-01T00:00:00.000Z",
                    key: "test-token",
                    user_id: "user-1",
                },
            }),
        );

        const usage = await fetchGrokProviderUsage({
            authFile,
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/v1/billing") {
                    return Response.json({
                        config: {
                            creditUsagePercent: 37,
                            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
                        },
                    });
                }
                if (path === "/v1/user") {
                    return new Response("{", { status: 200 });
                }
                throw new Error(`Unexpected request ${path}`);
            },
        });

        expect(usage?.windows.monthly?.usedPercent).toBe(37);
    });
});
