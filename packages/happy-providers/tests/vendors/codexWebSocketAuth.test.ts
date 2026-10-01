import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import { testContext } from "../testContext.js";

const require = createRequire(import.meta.url);
const { WebSocketServer } = createRequire(require.resolve("openai"))("ws") as typeof import("ws");

vi.mock("@/vendors/codex/impl/resolveCodexInstallationId.js", () => ({
    resolveCodexInstallationId: async () => "diagnostic-installation",
}));

// Synthetic in-band error envelope; not a capture from the user's actual failed request.
describe("Codex WebSocket authentication recovery", () => {
    it.each(["status", "status_code"])(
        "recovers an in-band %s 401 from an already rotated same-account login",
        async (statusKey) => {
            const root = await mkdtemp(join(tmpdir(), "codex-ws-auth-diagnostic-"));
            const authFile = join(root, "auth.json");
            const store = async (accessToken: string) =>
                writeFile(
                    authFile,
                    JSON.stringify({
                        tokens: {
                            access_token: accessToken,
                            refresh_token: "synthetic-refresh",
                            account_id: "same-account",
                        },
                    }),
                );
            await store("old-access");
            const oldCredential = await CodexSessionCredential.tryLoad({ authFile });
            if (oldCredential === null) throw new Error("Missing synthetic credential.");
            await store("fresh-access");
            const server = createServer();
            const sockets = new WebSocketServer({ server });
            const tokens: string[] = [];
            sockets.on("connection", (socket, request) => {
                const token = request.headers.authorization ?? "";
                tokens.push(token);
                socket.on("message", () => {
                    socket.send(
                        JSON.stringify(
                            token === "Bearer old-access"
                                ? {
                                      type: "error",
                                      [statusKey]: 401,
                                      error: {
                                          type: "authentication_error",
                                          message:
                                              "Encountered invalidated oauth token for user, failing request",
                                      },
                                  }
                                : {
                                      type: "response.completed",
                                      response: {
                                          id: "synthetic-response",
                                          output: [],
                                          usage: {
                                              input_tokens: 1,
                                              output_tokens: 1,
                                              total_tokens: 2,
                                          },
                                      },
                                  },
                        ),
                    );
                });
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (address === null || typeof address === "string")
                throw new Error("Missing loopback port.");
            const provider = (credential: CodexSessionCredential) =>
                new CodexProvider({
                    credential,
                    endpoint: `http://127.0.0.1:${address.port}/backend-api`,
                    transport: "websocket",
                    parallelToolCalls: true,
                    model: "gpt-5.6-sol",
                    inferenceMaxRetries: 0,
                });
            const oldSession = await provider(oldCredential).session("old-session", {
                instructions: "",
            });
            const fresh = await CodexSessionCredential.tryLoad({ authFile });
            if (fresh === null) throw new Error("Missing replacement credential.");
            const newSession = await provider(fresh).session("new-session", { instructions: "" });
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
                for (let turn = 0; turn < 2; turn += 1) {
                    const events = await collect(oldSession.run(testContext, request));
                    expect(events.at(-1)).toMatchObject({
                        type: "done",
                        state: "normal",
                    });
                }
                const events = await collect(newSession.run(testContext, request));
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(tokens).toEqual([
                    "Bearer old-access",
                    "Bearer fresh-access",
                    "Bearer fresh-access",
                ]);
            } finally {
                await oldSession.destroy();
                await newSession.destroy();
                for (const socket of sockets.clients) socket.terminate();
                await new Promise<void>((resolve) => sockets.close(() => resolve()));
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
