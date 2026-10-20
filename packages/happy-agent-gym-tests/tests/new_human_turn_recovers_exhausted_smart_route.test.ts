import { createAgentGym } from "@slopus/happy-agent-gym";
import { describe, expect, it } from "vitest";

describe("smart route recovery on a new human turn", () => {
    it("tries the account again after a terminal authentication rejection", async () => {
        const modelId = "openai/gpt-5.6-sol";
        const gym = await createAgentGym({
            routeConfiguredProviders: true,
            models: ["gym", "router"].map((providerId) => ({
                id: modelId,
                name: "Routed fixture model",
                providerId,
                defaultEffort: "medium",
                effortLevels: ["medium"],
            })),
            config: [
                "[providers]",
                "default_enable = false",
                "[providers.gym]",
                'type = "codex"',
                "enabled = true",
                "hidden = true",
                "credential_isolation = true",
                "[providers.router]",
                'type = "smart"',
                'providers = ["gym"]',
                "enabled = true",
            ].join("\n"),
            inference: [
                {
                    error: {
                        kind: "unknown",
                        message: "Synthetic routed authentication rejection.",
                        providerError: { type: "authentication" },
                    },
                },
                { content: [{ type: "text", text: "Routed account recovered." }] },
            ],
        });
        try {
            await gym.send("Try the selected account.", { providerId: "router", modelId });
            // The rejection is recorded as its typed failure, not the provider's own text.
            expect(JSON.stringify(await gym.history())).toContain('"kind":"signin_missing"');
            expect(gym.inference.requests).toHaveLength(1);

            await gym.send("Continue after credentials have recovered.", {
                providerId: "router",
                modelId,
            });
            expect(gym.inference.requests).toHaveLength(2);
            expect(gym.inference.requests[1]?.sessionId).toBe(gym.defaultSessionId);
            expect(gym.inference.userTexts()).toContain(
                "Continue after credentials have recovered.",
            );
            expect(JSON.stringify(await gym.history())).toContain("Routed account recovered.");
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        } finally {
            await gym.dispose();
        }
    }, 30_000);
});
