import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import { ClaudeOAuthCredential } from "@/vendors/claude/ClaudeOAuthCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { testContext } from "../testContext.js";

// Synthetic 401, real pinned SDK transport, loopback only, synthetic access token.
describe("Claude SDK authentication follow-up", () => {
    it(
        "closes the rejected query and starts a new query on follow-up with the identical token",
        { timeout: 30_000 },
        async () => {
            const root = await mkdtemp(join(tmpdir(), "claude-auth-followup-"));
            const fixture = JSON.parse(
                await readFile(
                    new URL("./fixtures/claude-provider-multiturn.json", import.meta.url),
                    "utf8",
                ),
            );
            const success = fixture.exchanges[1].response.events
                .map(
                    (event: { type: string }) =>
                        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join("");
            const authorizations: string[] = [];
            let reject = true;
            const server = createServer((request, response) => {
                if (
                    request.method !== "POST" ||
                    !request.url?.startsWith("/v1/messages") ||
                    request.url.includes("count_tokens")
                ) {
                    response.writeHead(404, { "content-type": "application/json" });
                    response.end("{}");
                    return;
                }
                authorizations.push(request.headers.authorization ?? "");
                if (reject) {
                    response.writeHead(401, { "content-type": "application/json" });
                    response.end(
                        JSON.stringify({
                            type: "error",
                            error: {
                                type: "authentication_error",
                                message:
                                    "OAuth access token has expired. Re-authenticate to continue.",
                            },
                        }),
                    );
                } else {
                    response.writeHead(200, { "content-type": "text/event-stream" });
                    response.end(success);
                }
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (address === null || typeof address === "string")
                throw new Error("Missing loopback port.");
            const credential = await ClaudeOAuthCredential.tryLoad({
                oauthToken: "synthetic-access-token",
            });
            if (credential === null) throw new Error("Missing synthetic credential.");
            let starts = 0;
            const exits: Promise<void>[] = [];
            const session = new ClaudeSession("sdk-followup-diagnostic", {
                credential,
                instructions: "",
                model: "opus[1m]",
                inferenceMaxRetries: 0,
                env: {
                    PATH: process.env.PATH,
                    TMPDIR: root,
                    CLAUDE_CONFIG_DIR: root,
                    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
                    CLAUDE_CODE_OAUTH_401_WAIT_MS: "0",
                },
                query: (parameters) => {
                    starts += 1;
                    return query({
                        ...parameters,
                        options: {
                            ...parameters.options,
                            cwd: root,
                            spawnClaudeCodeProcess: (options) => {
                                const child = spawn(options.command, options.args, {
                                    cwd: options.cwd,
                                    env: options.env,
                                    signal: options.signal,
                                    stdio: ["pipe", "pipe", "pipe"],
                                });
                                child.stderr.resume();
                                exits.push(
                                    new Promise<void>((resolve) =>
                                        child.once("close", () => resolve()),
                                    ),
                                );
                                return child;
                            },
                        },
                    });
                },
                tools: [],
            });
            const request = {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user" as const,
                            content: [{ type: "text" as const, text: "Hello" }],
                        },
                    ],
                },
            };
            try {
                const first = await collect(session.run(testContext, request));
                expect(first.at(-1)).toMatchObject({
                    type: "done",
                    state: "error",
                    message: expect.stringContaining("OAuth access token has expired"),
                    providerError: {
                        type: "authentication",
                        diagnostics: { code: "authentication_failed" },
                    },
                });
                expect(starts).toBe(1);
                reject = false;
                const second = await collect(session.run(testContext, request));
                expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(starts).toBe(2);
                expect(authorizations.length).toBeGreaterThanOrEqual(2);
                expect(new Set(authorizations)).toEqual(new Set(["Bearer synthetic-access-token"]));
            } finally {
                session.destroy();
                await Promise.all(exits);
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await rm(root, { recursive: true, force: true });
            }
        },
    );
});

async function collect(stream: SessionStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}
