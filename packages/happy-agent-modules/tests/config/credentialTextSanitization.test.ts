import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    AnthropicProvider,
    ClaudeCodeCredential,
    CodexProvider,
    type SessionEvent,
    type BaseSession,
    type BaseProvider,
} from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import type { ConfigModule } from "../../sources/config/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { ScriptedSession } from "../support/ScriptedProvider.js";

describe.each([
    "configured-key",
    "environment-key",
    "native-codex",
    "custom-claude",
    "default-claude",
] as const)("%s credential prose", (source) => {
    it.each(["conversation", "naming:conversation", "router:conversation"])(
        "sanitizes the construction-time source in %s without changing typed failure or unrelated paragraphs",
        async (sessionId) => {
            const root = await mkdtemp(join(tmpdir(), "credential-prose-"));
            const codexHome = join(root, "codex");
            const authFile = join(codexHome, "auth.json");
            const customClaude = "./synthetic-claude-source";
            const claude = source.endsWith("claude");
            let config: ConfigModule | undefined;
            let session: BaseSession | undefined;
            let nativeClaude: ClaudeCodeCredential | undefined;
            try {
                vi.stubEnv("CODEX_HOME", codexHome);
                vi.stubEnv(
                    "OPENAI_API_KEY",
                    source === "environment-key" ? "synthetic-env-key" : "",
                );
                vi.stubEnv("ANTHROPIC_API_KEY", "");
                vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
                vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
                vi.stubEnv("CLAUDE_CONFIG_DIR", "");
                const markers = [hostname()];
                const entries: string[] = [];
                if (source === "configured-key") {
                    entries.push('api_key = "synthetic-config-key"', "credential_isolation = true");
                    markers.push("providers.private_account.api_key");
                } else if (source === "environment-key") {
                    markers.push("OPENAI_API_KEY");
                } else if (source === "native-codex") {
                    await mkdir(codexHome);
                    await writeFile(
                        authFile,
                        JSON.stringify({
                            tokens: {
                                access_token: "synthetic-native-token",
                                account_id: "synthetic-account",
                            },
                        }),
                    );
                    markers.push(authFile, codexHome, "CODEX_HOME");
                } else {
                    // Keep native credential discovery/SDK subprocesses outside this test. The real
                    // published credential value preserves the selected-directory distinction.
                    vi.spyOn(ClaudeCodeCredential, "tryLoad").mockImplementation(
                        async (options = {}) => {
                            nativeClaude = Reflect.construct(ClaudeCodeCredential, [
                                options.configDir,
                            ]) as ClaudeCodeCredential;
                            expect(nativeClaude).toBeInstanceOf(ClaudeCodeCredential);
                            return nativeClaude;
                        },
                    );
                    if (source === "custom-claude") {
                        entries.push(
                            `config_dir = "${customClaude}"`,
                            "credential_isolation = true",
                        );
                        markers.push("providers.private_account.config_dir");
                    }
                }
                config = await testConfigRootedAt(
                    root,
                    [
                        "[node]",
                        'name = "Private diagnostic host"',
                        "[providers]",
                        "default_enable = false",
                        "[providers.private_account]",
                        `type = "${claude ? "claude" : "codex"}"`,
                        "enabled = true",
                        ...entries,
                        "[providers.router]",
                        'type = "smart"',
                        'providers = ["private_account"]',
                        "enabled = true",
                    ].join("\n"),
                );
                markers.push(await config.initialNodeName());
                let scripted: SessionEvent[] = [];
                // This seam is below Config: every test enters via its public concrete/router registry.
                const prototype: BaseProvider = claude
                    ? AnthropicProvider.prototype
                    : CodexProvider.prototype;
                vi.spyOn(prototype, "session").mockImplementation(
                    async (id, options) => new ScriptedSession(id, [scripted], options),
                );
                const selectedModel = claude ? "anthropic/sonnet-5-5" : "openai/gpt-5.6-sol";
                // Resolving the concrete provider constructs the real selected credential.
                await config.providers.resolve("private_account", selectedModel);
                if (claude) {
                    expect(nativeClaude).toBeInstanceOf(ClaudeCodeCredential);
                    expect(nativeClaude!.configDir).toBe(
                        source === "custom-claude" ? customClaude : undefined,
                    );
                    markers.push(
                        ...(nativeClaude!.configDir === undefined
                            ? [join(homedir(), ".claude")]
                            : [nativeClaude!.configDir, resolve(nativeClaude!.configDir)]),
                    );
                }
                const suffix =
                    "First safe paragraph.\n\nSecond safe paragraph mentions /ordinary/project/file and UNUSED_ENV_NAME.";
                const text = `Authentication failed: ${markers.join("; ")}.\n\n${suffix}`;
                const failure: SessionEvent = {
                    type: "done",
                    state: "error",
                    kind: "unknown",
                    message: text,
                    providerError: {
                        type: "authentication",
                        diagnostics: { status: 401, code: "authentication_error" },
                    },
                };
                scripted = [{ type: "retrying", attempt: 1, reason: text }, failure];
                const provider = await config.providers.resolve(
                    sessionId.startsWith("router:") ? "router" : "private_account",
                    selectedModel,
                );
                if (provider === null) throw new Error("Missing configured fixture provider.");
                session = await provider.session(sessionId, { instructions: "test" });
                // Changing the current environment must not alter what this selected session knows.
                if (!sessionId.startsWith("router:"))
                    vi.stubEnv("CODEX_HOME", join(root, "new-current-source"));
                const events: SessionEvent[] = [];
                for await (const event of session.run(createRootContext(), {
                    context: {
                        instructions: "test",
                        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                    },
                }))
                    events.push(event);
                expect(events.map((event) => event.type)).toEqual(["retrying", "done"]);
                expect(events.at(-1)).toMatchObject({
                    type: "done",
                    state: "error",
                    providerError: {
                        type: "authentication",
                        diagnostics: { status: 401, code: "authentication_error" },
                    },
                });
                for (const event of events) {
                    const serialized = JSON.stringify(event);
                    for (const marker of markers) expect(serialized).not.toContain(marker);
                    expect(serialized).toContain(JSON.stringify(suffix).slice(1, -1));
                }
                expect(failure).toMatchObject({ message: text });
            } finally {
                await session?.destroy();
                await config?.closeProviders();
                vi.restoreAllMocks();
                vi.unstubAllEnvs();
                await rm(root, { recursive: true, force: true });
            }
        },
    );
});
