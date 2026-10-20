import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HappyAgentApiError, type ServiceMessage } from "@slopus/happy-agent-client";
import { ClaudeCodeCredential } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

const model = "anthropic/sonnet-5-5";

// A failed turn is resolved on its own message: Retry and Switch record what the person did and
// start the continued run without adding a user message, once.
it("records a retry on the failed message, runs again, and stays idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "failure-resolution-"));
    let fixture: Awaited<ReturnType<typeof credentialWriterRuntime>> | undefined;
    try {
        vi.stubEnv("HOME", root);
        for (const key of [
            "CLAUDE_CONFIG_DIR",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ])
            vi.stubEnv(key, undefined);
        vi.spyOn(ClaudeCodeCredential, "tryLoad").mockResolvedValue(null);
        fixture = await credentialWriterRuntime("owner", {
            defaultModel: model,
            providerConfiguration: `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "claude"\nenabled = true\n`,
        });
        const { owner, agent } = fixture;
        await owner.sendMessage(agent.id, {
            text: "Fail without a sign-in.",
            mode: { ...writerMode, modelId: model },
        });
        const failures = async () =>
            (await owner.getMessages(agent.id)).runs
                .flatMap((run) => run.messages)
                .filter(
                    (row): row is ServiceMessage =>
                        row.role === "service" && row.failure !== undefined,
                );
        await vi.waitFor(async () => expect(await failures()).toHaveLength(1), {
            timeout: 10_000,
            interval: 10,
        });
        const [failed] = await failures();
        const userMessages = async () =>
            (await owner.getMessages(agent.id)).runs
                .flatMap((run) => run.messages)
                .filter((row) => row.role === "user");
        expect(await userMessages()).toHaveLength(1);

        // Only one of the failure's alternatives may be switched to; there are none here.
        await expect(
            owner.switchAndContinue(agent.id, failed!.id, {
                providerId: "private_account",
                modelId: model,
            }),
        ).rejects.toMatchObject({ status: 400 });
        // A message that is not a failure cannot be retried.
        const [user] = await userMessages();
        await expect(owner.retryFailedTurn(agent.id, user!.id)).rejects.toBeInstanceOf(
            HappyAgentApiError,
        );

        const retried = await owner.retryFailedTurn(agent.id, failed!.id);
        expect(retried.message).toMatchObject({
            id: failed!.id,
            failure: { kind: "signin_missing", resolution: { action: "retried" } },
        });
        // The continued run fails the same way and leaves a second, unresolved failure.
        await vi.waitFor(async () => expect(await failures()).toHaveLength(2), {
            timeout: 10_000,
            interval: 10,
        });
        const [first, second] = await failures();
        expect(first?.failure?.resolution).toMatchObject({ action: "retried" });
        expect(second?.failure?.resolution).toBeUndefined();
        expect(await userMessages()).toHaveLength(1);

        // Retrying the resolved failure again answers with its state and starts nothing.
        const again = await owner.retryFailedTurn(agent.id, failed!.id);
        expect(again.message).toEqual(retried.message);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await failures()).toHaveLength(2);
    } finally {
        await fixture?.close();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
