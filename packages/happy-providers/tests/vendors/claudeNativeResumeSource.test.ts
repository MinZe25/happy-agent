import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import * as claudeAuth from "@/vendors/claude/impl/auth.js";
import { testContext } from "../testContext.js";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

// Inspection-only SDK staging fixture: intercept the subprocess before it can start. No real
// keychain lookup, subprocess, provider request, or refresh is performed. History stays isolated,
// while the original native credential namespace must remain authoritative.
describe("Claude native resume credential staging", () => {
    it.each([
        { withFile: false, defaultSource: false },
        { withFile: true, defaultSource: false },
        { withFile: true, defaultSource: true },
    ])(
        "preserves source binding through staging (file: $withFile, default: $defaultSource)",
        async ({ withFile, defaultSource }) => {
            const root = await mkdtemp(join(tmpdir(), "claude-native-resume-source-"));
            const syntheticCredentials = JSON.stringify({
                claudeAiOauth: {
                    accessToken: "synthetic-native-access",
                    refreshToken: "synthetic-native-refresh",
                    expiresAt: 4_000_000_000_000,
                },
            });
            if (withFile) await writeFile(join(root, ".credentials.json"), syntheticCredentials);
            // Default-source staging consults the SDK parent's environment. Keep that fallback
            // synthetic too; the captured child must still use the default native sentinel.
            vi.stubEnv("CLAUDE_CONFIG_DIR", root);
            vi.spyOn(claudeAuth, "readClaudeCodeOAuthToken").mockResolvedValue(
                "synthetic-native-access",
            );
            const credential = await ClaudeCodeCredential.tryLoad({
                ...(defaultSource ? {} : { configDir: root }),
                env: {},
            });
            if (credential === null) throw new Error("Missing synthetic native credential.");
            let childEnvironment: NodeJS.ProcessEnv | undefined;
            let copiedCredentials: string | undefined;
            let inspectCopy: Promise<void> | undefined;
            const session = new ClaudeSession("native-resume-staging", {
                credential,
                env: { PATH: process.env.PATH, TMPDIR: root },
                instructions: "",
                model: "opus[1m]",
                tools: [],
                query: (parameters) =>
                    query({
                        ...parameters,
                        options: {
                            ...parameters.options,
                            cwd: root,
                            spawnClaudeCodeProcess: (options) => {
                                childEnvironment = options.env;
                                const staged = options.env?.CLAUDE_CONFIG_DIR;
                                inspectCopy = (async () => {
                                    if (staged === undefined) return;
                                    copiedCredentials = await readFile(
                                        join(staged, ".credentials.json"),
                                        "utf8",
                                    ).catch(() => undefined);
                                })();
                                throw new Error("Fixture stops before any native process starts.");
                            },
                        },
                    }),
            });
            try {
                for await (const _event of session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            { role: "user", content: [{ type: "text", text: "First request." }] },
                            {
                                role: "assistant",
                                content: [{ type: "text", text: "First answer." }],
                            },
                            { role: "user", content: [{ type: "text", text: "Continue." }] },
                        ],
                    },
                })) {
                    // Drain the deliberate pre-spawn failure.
                }
                await inspectCopy;
                expect(childEnvironment?.CLAUDE_CONFIG_DIR).toContain("claude-resume-");
                expect(childEnvironment?.CLAUDE_CONFIG_DIR).not.toBe(root);
                expect(childEnvironment?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
                    defaultSource ? "" : root,
                );
                if (withFile) {
                    expect(copiedCredentials).toContain("synthetic-native-access");
                    expect(copiedCredentials).not.toContain("synthetic-native-refresh");
                    expect(await readFile(join(root, ".credentials.json"), "utf8")).toBe(
                        syntheticCredentials,
                    );
                } else {
                    expect(copiedCredentials).toBeUndefined();
                }
            } finally {
                session.destroy();
                await inspectCopy;
                await rm(root, { recursive: true, force: true });
            }
        },
    );
});
