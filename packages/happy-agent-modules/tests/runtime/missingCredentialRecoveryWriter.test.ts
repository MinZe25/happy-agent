import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeCredential } from "@slopus/happy-providers";
import type { ServiceMessage } from "@slopus/happy-agent-client";
import { describe, expect, it, vi } from "vitest";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

const withheldStep =
    "Retry this conversation. If it still fails, ask the person who manages this installation to check the selected provider.";

// A missing credential fails while the provider is opened, before any attempt exists. Every reader
// gets the same typed signin_missing failure and one short sentence; only the vendor's own default
// login names its command. The legacy owner-only details stay for clients older than protocol 30.
describe.each([
    {
        source: "default Claude",
        type: "claude",
        vendorName: "Claude",
        model: "anthropic/sonnet-5-5",
        fields: [],
        product: "Claude Code",
        command: "claude auth login",
    },
    {
        source: "custom Claude",
        type: "claude",
        vendorName: "Claude",
        model: "anthropic/sonnet-5-5",
        fields: ['config_dir = "/synthetic/custom-claude"', "credential_isolation = true"],
        product: "Claude Code",
        command: null,
    },
    {
        source: "default Codex",
        type: "codex",
        vendorName: "Codex",
        model: "openai/gpt-5.6-sol",
        fields: [],
        product: "Codex",
        command: "codex login",
    },
    {
        source: "default Grok",
        type: "grok",
        vendorName: "Grok",
        model: "xai/grok-4.7",
        fields: [],
        product: "Grok",
        command: "grok login",
    },
] as const)(
    "$source with no credential",
    ({ type, vendorName, model, fields, product, command }) => {
        const text =
            command === null
                ? "private_account has no credentials. Check its settings, then retry."
                : `${product} isn't signed in. Run ${command}, then retry.`;
        it.each(["owner", "member"] as const)(
            "gives the %s a typed sign-in failure with one short sentence",
            async (authority) => {
                const root = await mkdtemp(join(tmpdir(), "missing-credential-"));
                let fixture: Awaited<ReturnType<typeof credentialWriterRuntime>> | undefined;
                try {
                    vi.stubEnv("HOME", root);
                    for (const key of [
                        "CODEX_HOME",
                        "GROK_HOME",
                        "CLAUDE_CONFIG_DIR",
                        "OPENAI_API_KEY",
                        "XAI_API_KEY",
                        "ANTHROPIC_API_KEY",
                        "ANTHROPIC_AUTH_TOKEN",
                        "CLAUDE_CODE_OAUTH_TOKEN",
                    ])
                        vi.stubEnv(key, undefined);
                    // The real loader would read the macOS keychain; nothing signed in reads as null.
                    vi.spyOn(ClaudeCodeCredential, "tryLoad").mockResolvedValue(null);
                    fixture = await credentialWriterRuntime(authority, {
                        defaultModel: model,
                        providerConfiguration: `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "${type}"\nenabled = true\n${fields.join("\n")}\n`,
                    });
                    await fixture.owner.sendMessage(fixture.agent.id, {
                        text: "Use a provider that has no sign-in.",
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
                        .find(
                            (row): row is ServiceMessage =>
                                row.role === "service" && row.failure !== undefined,
                        );
                    expect(message?.content).toEqual([{ type: "text", text }]);
                    expect(message?.failure).toEqual({
                        kind: "signin_missing",
                        message: text,
                        provider: {
                            id: "private_account",
                            type,
                            vendorName,
                            label: "private_account",
                        },
                        product: command === null ? null : product,
                        command,
                        fallbackProviders: [],
                    });
                    expect(JSON.stringify(history)).not.toMatch(
                        /authentication is|no usable sign-in|Retrying alone/u,
                    );
                    expect(message?.error).toMatchObject({
                        code: "credentials_unavailable",
                        mode: null,
                        credentialSource: null,
                        recovery: { actions: ["ask_chief"] },
                    });
                    if (authority === "owner") {
                        expect(message?.error?.recovery.steps).toEqual([
                            command === null
                                ? "Restore the credentials this provider is configured to use on the machine running Happy Agent, then retry."
                                : `Run ${command} on the machine running Happy Agent, then retry.`,
                        ]);
                        if (command === "claude auth login")
                            expect(message?.error?.recovery.commands).toEqual([
                                { label: "Sign in to Claude Code", command: "claude auth login" },
                            ]);
                        else expect(message).not.toHaveProperty("error.recovery.commands");
                    } else {
                        expect(message?.error?.recovery.steps).toEqual([withheldStep]);
                        expect(message).not.toHaveProperty("error.recovery.commands");
                        expect(JSON.stringify(history)).not.toContain("Private writer host");
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
    },
);

it("gives a smart route's exhausted candidate the same typed failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "missing-credential-route-"));
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
        const model = "anthropic/sonnet-5-5";
        fixture = await credentialWriterRuntime("owner", {
            defaultModel: model,
            providerConfiguration: `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "claude"\nenabled = true\n[providers.router]\ntype = "smart"\nenabled = true\nproviders = ["private_account"]\n`,
        });
        await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Route to an account that has no sign-in.",
            mode: { ...writerMode, providerId: "router", modelId: model },
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
        const message = (await fixture.owner.getMessages(fixture.agent.id)).runs
            .flatMap((run) => run.messages)
            .find(
                (row): row is ServiceMessage => row.role === "service" && row.failure !== undefined,
            );
        // The failure names the account that had no sign-in, not the smart alias that chose it.
        expect(message?.failure).toMatchObject({
            kind: "signin_missing",
            message: "Claude Code isn't signed in. Run claude auth login, then retry.",
            provider: { id: "private_account", type: "claude" },
            command: "claude auth login",
        });
        expect(message?.error).toMatchObject({
            code: "credentials_unavailable",
            recovery: {
                commands: [{ label: "Sign in to Claude Code", command: "claude auth login" }],
            },
        });
    } finally {
        await fixture?.close();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
