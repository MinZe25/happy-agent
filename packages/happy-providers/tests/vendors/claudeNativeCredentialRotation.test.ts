import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionContext } from "@/core/SessionContext.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { collectSessionEvents } from "../helpers/collectSessionEvents.js";
import { testContext } from "../testContext.js";
import fixture from "./fixtures/claude-provider-multiturn.json" with { type: "json" };

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

// Run in an offline Linux container: native file storage and the real SDK child are exercised,
// while no host keychain, real account, or vendor network endpoint is accessible.
describe.skipIf(process.platform !== "linux")("Claude native credential rotation", () => {
    it("keeps one resumed child alive and adopts an external rotation instead of stale staging", async () => {
        const root = await mkdtemp(join(tmpdir(), "claude-native-rotation-"));
        const selected = join(root, "selected");
        await mkdir(selected);
        const original = join(selected, ".credentials.json");
        const credentials = (accessToken: string, refreshToken: string) =>
            JSON.stringify({
                claudeAiOauth: {
                    accessToken,
                    refreshToken,
                    expiresAt: Date.now() + 3_600_000,
                    scopes: ["user:inference", "user:profile"],
                    subscriptionType: "max",
                },
            });
        await writeFile(
            original,
            credentials("synthetic-original-access", "synthetic-original-refresh"),
        );
        vi.stubEnv("CLAUDE_CONFIG_DIR", selected);
        const credential = await ClaudeCodeCredential.tryLoad({ configDir: selected, env: {} });
        if (credential === null) throw new Error("Missing synthetic native credential.");

        let acceptedAccess = "synthetic-original-access";
        const authorizations: string[] = [];
        const bodies: string[] = [];
        const success = fixture.exchanges[1]!.response.events.map(
            (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ).join("");
        const server = createServer(async (request, response) => {
            const url = new URL(request.url ?? "/", "http://fixture.invalid");
            if (request.method !== "POST" || url.pathname !== "/v1/messages") {
                response.writeHead(404);
                response.end("{}");
                return;
            }
            let body = "";
            for await (const chunk of request) body += String(chunk);
            bodies.push(body);
            authorizations.push(request.headers.authorization ?? "");
            if (request.headers.authorization !== `Bearer ${acceptedAccess}`) {
                response.writeHead(401, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "authentication_error",
                            message: "OAuth access token has expired. Re-authenticate to continue.",
                        },
                    }),
                );
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(success);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing fixture port.");
        const children: ChildProcess[] = [];
        const exits: Promise<void>[] = [];
        let stagedPath: string | undefined;
        const session = new ClaudeSession("native-rotation", {
            credential,
            cwd: root,
            instructions: "",
            model: "opus[1m]",
            inferenceMaxRetries: 1,
            tools: [],
            env: {
                PATH: process.env.PATH,
                TMPDIR: root,
                CLAUDE_CODE_TMPDIR: root,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
                CLAUDE_CODE_OAUTH_401_WAIT_MS: "0",
            },
            query: (parameters) =>
                query({
                    ...parameters,
                    options: {
                        ...parameters.options,
                        spawnClaudeCodeProcess: (options) => {
                            const staged = options.env.CLAUDE_CONFIG_DIR;
                            if (!staged?.includes("claude-resume-"))
                                throw new Error("Missing SDK history staging.");
                            stagedPath = join(staged, ".credentials.json");
                            const child = spawn(options.command, options.args, {
                                cwd: options.cwd,
                                env: options.env,
                                signal: options.signal,
                                stdio: ["pipe", "pipe", "pipe"],
                            });
                            child.stderr.resume();
                            children.push(child);
                            exits.push(
                                new Promise<void>((resolve) =>
                                    child.once("close", () => resolve()),
                                ),
                            );
                            return child;
                        },
                    },
                }),
        });
        const context: SessionContext = {
            instructions: "",
            messages: [
                { role: "user", content: [{ type: "text", text: "Earlier request." }] },
                { role: "assistant", content: [{ type: "text", text: "Earlier answer." }] },
                { role: "user", content: [{ type: "text", text: "Before external rotation." }] },
            ],
        };
        try {
            const first = await collectSessionEvents(session.run(testContext, { context }));
            expect(first.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(children).toHaveLength(1);
            expect(children[0]?.exitCode).toBeNull();
            expect(authorizations).toEqual(["Bearer synthetic-original-access"]);
            if (stagedPath === undefined) throw new Error("Missing staged credential path.");
            const stagedBefore = await readFile(stagedPath, "utf8");
            expect(stagedBefore).toContain("synthetic-original-access");
            expect(stagedBefore).not.toContain("refreshToken");

            // An independent native CLI rotates the original store while this child stays alive.
            const rotated = credentials("synthetic-rotated-access", "synthetic-rotated-refresh");
            await writeFile(`${original}.next`, rotated);
            await rename(`${original}.next`, original);
            acceptedAccess = "synthetic-rotated-access";
            const assistant = assistantMessageFromEvents(first);
            if (assistant === undefined) throw new Error("Missing first assistant response.");
            const second = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: context.instructions,
                        messages: [
                            ...context.messages,
                            assistant,
                            {
                                role: "user",
                                content: [{ type: "text", text: "After external rotation." }],
                            },
                        ],
                    },
                }),
            );
            expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(children).toHaveLength(1);
            expect(children[0]?.exitCode).toBeNull();
            expect(authorizations.at(-1)).toBe("Bearer synthetic-rotated-access");
            expect(bodies.at(-1)).toContain("After external rotation.");
            expect(await readFile(stagedPath, "utf8")).toBe(stagedBefore);
            expect(await readFile(original, "utf8")).toBe(rotated);
        } finally {
            session.destroy();
            await Promise.all(exits);
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        }
    }, 30_000);
});
