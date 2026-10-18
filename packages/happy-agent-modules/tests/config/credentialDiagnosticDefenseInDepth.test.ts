import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    AnthropicProvider,
    CodexProvider,
    GrokProvider,
    type BaseProvider,
    type BaseSession,
    type SessionEvent,
} from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import type { ConfigModule } from "../../sources/config/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { ScriptedSession } from "../support/ScriptedProvider.js";

it.each([
    {
        type: "codex",
        field: "api_key",
        model: "openai/gpt-5.6-sol",
        prototype: CodexProvider.prototype,
    },
    {
        type: "claude",
        field: "api_key",
        model: "anthropic/sonnet-5-5",
        prototype: AnthropicProvider.prototype,
    },
    {
        type: "claude",
        field: "oauth_token",
        model: "anthropic/sonnet-5-5",
        prototype: AnthropicProvider.prototype,
    },
    {
        type: "claude",
        field: "auth_token",
        model: "anthropic/sonnet-5-5",
        prototype: AnthropicProvider.prototype,
    },
    { type: "grok", field: "api_key", model: "xai/grok-4.6", prototype: GrokProvider.prototype },
    {
        type: "bedrock",
        field: "bearer_token",
        model: "anthropic/sonnet-5",
        prototype: AnthropicProvider.prototype,
    },
])(
    "removes a configured $type $field echoed in provider diagnostics",
    async ({ type, field, model, prototype }) => {
        const secret = "synthetic.Secret+Value_42";
        const root = await mkdtemp(join(tmpdir(), "diagnostic-secret-"));
        let config: ConfigModule | undefined;
        let session: BaseSession | undefined;
        try {
            const prose = `Credential rejected: ${secret}.\n\nKeep prefix${secret}suffix and ordinary text.`;
            const original: SessionEvent = {
                type: "done",
                state: "error",
                kind: "unknown",
                message: prose,
                providerError: {
                    type: "authentication",
                    diagnostics: { status: 401, code: secret, upstreamMessage: prose },
                },
            };
            const providerPrototype: BaseProvider = prototype;
            vi.spyOn(providerPrototype, "session").mockImplementation(
                async (id, options) =>
                    new ScriptedSession(
                        id,
                        [
                            [
                                {
                                    type: "text_delta",
                                    delta: `Ordinary output mentions ${secret}.`,
                                },
                                { type: "retrying", attempt: 1, reason: prose },
                                original,
                            ],
                        ],
                        options,
                    ),
            );
            config = await testConfigRootedAt(
                root,
                `
[providers]
default_enable = false
[providers.private_account]
type = "${type}"
enabled = true
credential_isolation = true
${field} = "${secret}"
${type === "bedrock" ? 'region = "us-east-1"\ntransport = "mantle"' : ""}
`,
            );
            const provider = await config.providers.resolve("private_account", model);
            if (provider === null) throw new Error("Missing fixture provider.");
            session = await provider.session("conversation", { instructions: "test" });
            const events: SessionEvent[] = [];
            for await (const event of session.run(createRootContext(), {
                context: { instructions: "test", messages: [] },
            }))
                events.push(event);
            expect(events[0]).toEqual({
                type: "text_delta",
                delta: `Ordinary output mentions ${secret}.`,
            });
            expect(events.at(-1)).toMatchObject({
                providerError: { diagnostics: { status: 401, code: secret } },
            });
            const done = events.at(-1);
            const retry = events[1];
            if (done?.type !== "done" || done.state !== "error" || retry?.type !== "retrying")
                throw new Error("Missing diagnostic events.");
            for (const text of [
                done.message,
                done.providerError?.diagnostics?.upstreamMessage,
                retry.reason,
            ]) {
                expect.soft(text).not.toContain(`rejected: ${secret}`);
                expect(text).toContain(`\n\nKeep prefix${secret}suffix and ordinary text.`);
            }
            expect(original.message).toBe(prose);
        } finally {
            await session?.destroy();
            await config?.closeProviders();
            vi.restoreAllMocks();
            await rm(root, { recursive: true, force: true });
        }
    },
);

it.each(["codex", "grok"] as const)(
    "removes directory-only diagnostics after real default %s credential discovery",
    async (type) => {
        const root = await mkdtemp(join(tmpdir(), "diagnostic-directory-"));
        let config: ConfigModule | undefined;
        let session: BaseSession | undefined;
        try {
            vi.stubEnv("HOME", root);
            vi.stubEnv("CODEX_HOME", undefined);
            vi.stubEnv("GROK_HOME", undefined);
            vi.stubEnv("OPENAI_API_KEY", undefined);
            vi.stubEnv("XAI_API_KEY", undefined);
            const directory = join(homedir(), `.${type}`);
            expect(homedir()).toBe(root);
            await mkdir(directory);
            await writeFile(
                join(directory, "auth.json"),
                JSON.stringify(
                    type === "codex"
                        ? {
                              tokens: {
                                  access_token: "synthetic-native-token",
                                  account_id: "synthetic-account",
                              },
                          }
                        : {
                              "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
                                  key: "synthetic-native-token",
                                  expires_at: "2099-01-01T00:00:00Z",
                              },
                          },
                ),
            );
            const prose = `EACCES on directory ${directory}.\n\nRetry this conversation.`;
            const prototype: BaseProvider =
                type === "codex" ? CodexProvider.prototype : GrokProvider.prototype;
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
                                    message: prose,
                                    providerError: { type: "authentication" },
                                },
                            ],
                        ],
                        options,
                    ),
            );
            config = await testConfigRootedAt(
                root,
                `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "${type}"\nenabled = true\n`,
            );
            const provider = await config.providers.resolve(
                "private_account",
                type === "codex" ? "openai/gpt-5.6-sol" : "xai/grok-4.6",
            );
            expect(provider).toBeInstanceOf(type === "codex" ? CodexProvider : GrokProvider);
            session = await provider!.session("conversation", { instructions: "test" });
            const events: SessionEvent[] = [];
            for await (const event of session.run(createRootContext(), {
                context: { instructions: "test", messages: [] },
            }))
                events.push(event);
            const done = events.at(-1);
            if (done?.type !== "done" || done.state !== "error")
                throw new Error("Missing error diagnostic.");
            expect(done.message).not.toContain(directory);
            expect(done.message).toContain("\n\nRetry this conversation.");
        } finally {
            await session?.destroy();
            await config?.closeProviders();
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    },
);

it.each(["codex", "grok"] as const)(
    "already withholds a real default %s discovery symlink-loop path",
    async (type) => {
        const root = await mkdtemp(join(tmpdir(), "diagnostic-real-discovery-"));
        let config: ConfigModule | undefined;
        try {
            vi.stubEnv("HOME", root);
            for (const name of ["CODEX_HOME", "GROK_HOME", "OPENAI_API_KEY", "XAI_API_KEY"])
                vi.stubEnv(name, undefined);
            expect(homedir()).toBe(root);
            const directory = join(root, `.${type}`);
            await symlink(directory, directory);
            config = await testConfigRootedAt(
                root,
                `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "${type}"\nenabled = true\n`,
            );
            const failure = await config.providers
                .resolve(
                    "private_account",
                    type === "codex" ? "openai/gpt-5.6-sol" : "xai/grok-4.6",
                )
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect(failure).toMatchObject({ code: "ELOOP" });
            expect((failure as Error).message).not.toContain(directory);
        } finally {
            await config?.closeProviders();
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    },
);
