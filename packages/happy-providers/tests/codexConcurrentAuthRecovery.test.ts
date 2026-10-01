import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import { testContext } from "./testContext.js";

vi.mock("@/vendors/codex/impl/resolveCodexInstallationId.js", () => ({
    resolveCodexInstallationId: async () => "diagnostic-installation",
}));

const directories: string[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

// Synthetic responses, not a recording of the user's incident. No network or real credentials.
describe("Codex concurrent authentication recovery", () => {
    it.each([200, 400])(
        "adopts a same-account external rotation after our refresh returns HTTP %s",
        async (status) => {
            const { authFile, load } = await fixture();
            const credential = await load();
            const inferenceTokens: string[] = [];
            let refreshes = 0;
            vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
                if (String(input).endsWith("/oauth/token")) {
                    refreshes += 1;
                    // A separate owner saves a usable login while this exchange is pending.
                    await writeAuth(authFile, "external-fresh", "account-a");
                    return Response.json(
                        { access_token: "our-fresh", refresh_token: "our-refresh" },
                        { status },
                    );
                }
                const token = new Headers(init?.headers).get("authorization") ?? "";
                inferenceTokens.push(token);
                return token === "Bearer external-fresh" ? success() : unauthorized();
            });
            const session = await new CodexProvider({
                credential,
                endpoint: "https://diagnostic.invalid/backend-api",
                model: "gpt-5.6-sol",
                transport: "sse",
                inferenceMaxRetries: 0,
            }).session("same-session", { instructions: "" });
            try {
                const first = await collectSessionEvents(session.run(testContext, request));
                expect(first.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(refreshes).toBe(1);
                const followup = await collectSessionEvents(session.run(testContext, request));
                expect(followup.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(inferenceTokens).toEqual([
                    "Bearer stale",
                    "Bearer stale",
                    "Bearer external-fresh",
                    "Bearer external-fresh",
                ]);
                expect(refreshes).toBe(1);
                expect(await readFile(authFile, "utf8")).toContain("external-fresh");
            } finally {
                await session.destroy();
            }
        },
    );

    it("an account switch keeps the old session failing while a newly loaded session works", async () => {
        const { authFile, load } = await fixture();
        const original = await load();
        await writeAuth(authFile, "new-account-token", "account-b");
        let refreshes = 0;
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith("/oauth/token")) {
                refreshes += 1;
                throw new Error("Account switch must not refresh the replacement account.");
            }
            return new Headers(init?.headers).get("authorization") === "Bearer new-account-token"
                ? success()
                : unauthorized();
        });
        const provider = (credential: CodexSessionCredential) =>
            new CodexProvider({
                credential,
                endpoint: "https://diagnostic.invalid/backend-api",
                model: "gpt-5.6-sol",
                transport: "sse",
                inferenceMaxRetries: 0,
            });
        const oldSession = await provider(original).session("old", { instructions: "" });
        const newSession = await provider(await load()).session("new", { instructions: "" });
        try {
            for (let turn = 0; turn < 2; turn += 1) {
                const events = await collectSessionEvents(oldSession.run(testContext, request));
                expect(events.at(-1)).toMatchObject({
                    type: "done",
                    state: "error",
                    providerError: { type: "authentication" },
                });
            }
            const events = await collectSessionEvents(newSession.run(testContext, request));
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(refreshes).toBe(0);
        } finally {
            await oldSession.destroy();
            await newSession.destroy();
        }
    });

    it.each(["different account", "removed login", "unchanged token", "unknown original account"])(
        "does not adopt or overwrite an external change with %s",
        async (change) => {
            const { authFile, load } = await fixture();
            const credential =
                change === "unknown original account"
                    ? CodexSessionCredential.fromAuth(
                          { accessToken: "stale" },
                          {
                              authFile,
                              env: {
                                  CODEX_REFRESH_TOKEN_URL_OVERRIDE:
                                      "https://diagnostic.invalid/oauth/token",
                              },
                          },
                      )
                    : await load();
            let expectedFile: string | undefined;
            vi.stubGlobal("fetch", async () => {
                if (change === "removed login") {
                    await rm(authFile);
                } else {
                    expectedFile = JSON.stringify({
                        marker: "external-change",
                        tokens: {
                            access_token: change === "unchanged token" ? "stale" : "external-fresh",
                            refresh_token: "external-refresh",
                            account_id: change === "different account" ? "account-b" : "account-a",
                        },
                    });
                    await writeFile(authFile, expectedFile);
                }
                return Response.json({ access_token: "our-fresh", refresh_token: "our-refresh" });
            });
            await expect(credential.refreshForUnauthorized()).rejects.toThrow();
            if (expectedFile === undefined) {
                await expect(readFile(authFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
            } else {
                expect(await readFile(authFile, "utf8")).toBe(expectedFile);
            }
        },
    );

    it("stops after the adopted replacement is also rejected", async () => {
        const { authFile, load } = await fixture();
        const credential = await load();
        let refreshes = 0;
        let inferences = 0;
        vi.stubGlobal("fetch", async (input: string | URL | Request) => {
            if (String(input).endsWith("/oauth/token")) {
                refreshes += 1;
                await writeAuth(authFile, "external-fresh", "account-a");
                return Response.json({}, { status: 400 });
            }
            inferences += 1;
            return unauthorized();
        });
        const session = await new CodexProvider({
            credential,
            endpoint: "https://diagnostic.invalid/backend-api",
            model: "gpt-5.6-sol",
            transport: "sse",
            inferenceMaxRetries: 0,
        }).session("bounded-recovery", { instructions: "" });
        try {
            const events = await collectSessionEvents(session.run(testContext, request));
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                providerError: { type: "authentication" },
            });
            expect(refreshes).toBe(1);
            expect(inferences).toBe(3);
        } finally {
            session.destroy();
        }
    });
});

const request = {
    context: {
        instructions: "",
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    },
};

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "codex-followup-diagnostic-"));
    directories.push(directory);
    const authFile = join(directory, "auth.json");
    await writeAuth(authFile, "stale", "account-a");
    return {
        authFile,
        load: async () => {
            const credential = await CodexSessionCredential.tryLoad({
                authFile,
                env: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: "https://diagnostic.invalid/oauth/token" },
            });
            if (credential === null) throw new Error("Synthetic credential missing.");
            return credential;
        },
    };
}

async function writeAuth(path: string, token: string, account: string) {
    await writeFile(
        path,
        JSON.stringify({
            tokens: {
                access_token: token,
                refresh_token: "synthetic-refresh",
                account_id: account,
            },
        }),
    );
}

function unauthorized() {
    return Response.json(
        { error: { type: "authentication_error", message: "expired" } },
        { status: 401 },
    );
}

function success() {
    return new Response(
        'data: {"type":"response.completed","response":{"id":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
    );
}

async function collectSessionEvents(stream: SessionStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}
