import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AnthropicProvider,
    ClaudeCodeCredential,
    CodexProvider,
    type BaseProvider,
} from "@slopus/happy-providers";
import { describe, expect, it, vi } from "vitest";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import {
    credentialWriterRuntime,
    writerMode,
    writerText,
} from "../support/credentialWriterRuntime.js";

describe.each([
    "default Claude",
    "custom Claude",
    "environment Claude",
    "configured Claude",
    "native Codex",
] as const)("%s recovery", (source) => {
    it.each(["owner", "member"] as const)(
        "writes only source-appropriate instructions for the %s",
        async (authority) => {
            const root = await mkdtemp(join(tmpdir(), "recovery-source-"));
            const secret = "synthetic-S5-private-secret";
            const customDirectory = join(root, "custom-claude");
            const codex = source === "native Codex";
            const model = codex ? "openai/gpt-5.6-sol" : "anthropic/sonnet-5-5";
            let fixture: Awaited<ReturnType<typeof credentialWriterRuntime>> | undefined;
            let nativeClaude: ClaudeCodeCredential | undefined;
            try {
                vi.stubEnv("HOME", root);
                for (const key of [
                    "CODEX_HOME",
                    "CLAUDE_CONFIG_DIR",
                    "OPENAI_API_KEY",
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                    "CLAUDE_CODE_OAUTH_TOKEN",
                ])
                    vi.stubEnv(key, undefined);
                const fields: string[] = [];
                if (source === "environment Claude") vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", secret);
                if (source === "configured Claude")
                    fields.push(`oauth_token = "${secret}"`, "credential_isolation = true");
                if (source === "custom Claude")
                    fields.push(`config_dir = "${customDirectory}"`, "credential_isolation = true");
                if (source === "default Claude" || source === "custom Claude") {
                    // Real native credential type/selection; never spawn the SDK or use a keychain.
                    vi.spyOn(ClaudeCodeCredential, "tryLoad").mockImplementation(
                        async (options = {}) => {
                            nativeClaude = Reflect.construct(ClaudeCodeCredential, [
                                options.configDir,
                            ]) as ClaudeCodeCredential;
                            return nativeClaude;
                        },
                    );
                }
                if (codex) {
                    await mkdir(join(root, ".codex"));
                    await writeFile(
                        join(root, ".codex/auth.json"),
                        JSON.stringify({
                            tokens: {
                                access_token: secret,
                                account_id: "synthetic-native-vendor-account",
                            },
                        }),
                    );
                }
                const prototype: BaseProvider = codex
                    ? CodexProvider.prototype
                    : AnthropicProvider.prototype;
                vi.spyOn(prototype, "session").mockImplementation(
                    async (id, options) =>
                        new ScriptedSession(
                            id,
                            [
                                [
                                    {
                                        type: "done",
                                        state: "error",
                                        kind: "unknown",
                                        message: writerText,
                                        providerError: {
                                            type: "authentication",
                                            diagnostics: { status: 401 },
                                        },
                                    },
                                ],
                            ],
                            options,
                        ),
                );
                fixture = await credentialWriterRuntime(authority, {
                    defaultModel: model,
                    providerConfiguration: `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "${codex ? "codex" : "claude"}"\nenabled = true\n${fields.join("\n")}\n`,
                });
                await fixture.owner.sendMessage(fixture.agent.id, {
                    text: "Exercise the selected credential source.",
                    mode: { ...writerMode, modelId: model },
                });
                await vi.waitFor(
                    async () =>
                        expect(
                            (await fixture!.owner.getMessages(fixture!.agent.id)).runs.some(
                                (run) => run.status === "failed",
                            ),
                        ).toBe(true),
                    { timeout: 10_000, interval: 10 },
                );
                const history = await fixture.reader.getMessages(fixture.agent.id);
                const message = history.runs
                    .flatMap((run) => run.messages)
                    .filter((row) => row.role === "service")
                    .find(
                        (row) =>
                            row.role === "service" &&
                            row.content.some(
                                (block) => block.type === "text" && block.text.includes(writerText),
                            ),
                    );
                expect(message).toBeDefined();
                expect.soft(message?.error).toMatchObject({
                    code: "authentication_failed",
                    mode: {
                        providerId: "private_account",
                        providerType: codex ? "codex" : "claude",
                        modelId: model,
                    },
                    recovery: { actions: ["ask_chief"] },
                });
                // API.md:4667-4735 requires selection-time source, safe descriptors and exact command eligibility.
                if (authority === "owner") {
                    const kind =
                        source === "configured Claude"
                            ? "configuration"
                            : source === "environment Claude"
                              ? "environment"
                              : "native_login";
                    expect
                        .soft(message?.error?.credentialSource)
                        .toMatchObject({ kind, host: "Private writer host" });
                    if (kind === "environment")
                        expect
                            .soft(message?.error?.credentialSource?.location)
                            .toBe("CLAUDE_CODE_OAUTH_TOKEN");
                    if (kind === "configuration")
                        expect
                            .soft(message?.error?.credentialSource?.location)
                            .toBe("providers.private_account.oauth_token");
                    if (source === "default Claude") {
                        expect
                            .soft(
                                message?.error?.recovery.commands?.map(
                                    (command) => command.command,
                                ),
                            )
                            .toEqual(["claude auth login"]);
                        expect
                            .soft(message?.error?.recovery.steps.join(" ") ?? "")
                            .toMatch(/retry/iu);
                        expect
                            .soft(message?.error?.recovery.steps.join(" ") ?? "")
                            .toMatch(/same.*(?:user|account)/iu);
                        expect
                            .soft(message?.error?.recovery.steps.join(" ") ?? "")
                            .toMatch(/(?:machine|computer).*agent/iu);
                    } else expect(message).not.toHaveProperty("error.recovery.commands");
                    expect.soft(message?.error?.recovery.steps.length ?? 0).toBeGreaterThan(0);
                } else {
                    // API.md:4737: ordinary reads disclose by authenticated installation-owner authority only.
                    expect.soft(message?.error?.credentialSource).toBeNull();
                    expect(message).not.toHaveProperty("error.recovery.commands");
                    expect
                        .soft(message?.error?.recovery.steps)
                        .toEqual([
                            "Retry this conversation. If it still fails, ask the person who manages this installation to check the selected provider.",
                        ]);
                    for (const marker of [
                        "Private writer host",
                        "CLAUDE_CODE_OAUTH_TOKEN",
                        "providers.private_account.oauth_token",
                        "claude auth login",
                    ])
                        expect(JSON.stringify(history)).not.toContain(marker);
                }
                for (const marker of [
                    secret,
                    root,
                    customDirectory,
                    "synthetic-native-vendor-account",
                ])
                    expect(JSON.stringify(history)).not.toContain(marker);
                if (source === "default Claude" || source === "custom Claude") {
                    expect(nativeClaude).toBeInstanceOf(ClaudeCodeCredential);
                    expect(nativeClaude!.configDir).toBe(
                        source === "custom Claude" ? customDirectory : undefined,
                    );
                }
            } finally {
                await fixture?.close();
                vi.restoreAllMocks();
                vi.unstubAllEnvs();
                await rm(root, { recursive: true, force: true });
            }
        },
        30_000,
    );
});
