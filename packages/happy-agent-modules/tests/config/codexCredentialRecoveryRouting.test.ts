import {
    CodexProvider,
    CodexSessionCredential,
    type BaseSession,
    type SessionEvent,
} from "@slopus/happy-providers";
import { AgentProviders } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { type ConfigModule } from "../../sources/config/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

it("routes to another real Codex account after a safe terminal credential-recovery failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-router-recovery-"));
    vi.stubEnv("CODEX_HOME", root);
    const authFile = join(root, "auth.json");
    const staleToken = "synthetic-stale-access-token";
    const refreshToken = "synthetic-private-refresh-token";
    const healthyToken = "synthetic-healthy-access-token";
    const auth = JSON.stringify({
        tokens: {
            access_token: staleToken,
            refresh_token: refreshToken,
            account_id: "synthetic-first-account",
        },
    });
    await writeFile(authFile, auth);
    const attempts: string[] = [];
    const server = createServer((request, response) => {
        request.resume();
        if (request.url === "/oauth/token") {
            attempts.push("refresh");
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_grant" }));
        } else if (request.headers.authorization === `Bearer ${healthyToken}`) {
            attempts.push("healthy");
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                'data: {"type":"response.completed","response":{"id":"healthy-response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
            );
        } else {
            attempts.push("stale");
            response.writeHead(401, { "content-type": "application/json" });
            response.end(
                JSON.stringify({ error: { type: "authentication_error", message: "expired" } }),
            );
        }
    });
    let config: ConfigModule | undefined;
    let routed: BaseSession | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No fixture port.");
        const endpoint = `http://127.0.0.1:${address.port}`;
        const firstCredential = await CodexSessionCredential.tryLoad({
            authFile,
            env: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${endpoint}/oauth/token` },
        });
        if (firstCredential === null) throw new Error("Missing synthetic credential.");
        const providerOptions = {
            endpoint: `${endpoint}/backend-api`,
            model: "gpt-5.6-sol",
            transport: "sse" as const,
            inferenceMaxRetries: 0,
        };
        const first = new CodexProvider({ ...providerOptions, credential: firstCredential });
        const second = new CodexProvider({
            ...providerOptions,
            credential: CodexSessionCredential.fromAuth(
                { accessToken: healthyToken, accountId: "synthetic-second-account" },
                { authFile: join(root, "healthy-auth.json"), env: {} },
            ),
        });
        const firstSession = await first.session("routed-codex", { instructions: "test" });
        const firstEvents: SessionEvent[] = [];
        const run = firstSession.run.bind(firstSession);
        // Observe the real published session's stream without changing its requests or events.
        vi.spyOn(firstSession, "run").mockImplementation(async function* (ctx, request) {
            for await (const event of run(ctx, request)) {
                firstEvents.push(event);
                yield event;
            }
        });
        vi.spyOn(first, "session").mockResolvedValue(firstSession);
        const accounts = new AgentProviders();
        accounts.add("first", first, "codex");
        accounts.add("second", second, "codex");
        config = await testConfigRootedAt(
            root,
            [
                "[providers]",
                "default_enable = false",
                ...["first", "second"].flatMap((id) => [
                    `[providers.${id}]`,
                    'type = "codex"',
                    "enabled = true",
                    "hidden = true",
                    "credential_isolation = true",
                ]),
                "[providers.router]",
                'type = "smart"',
                'providers = ["first", "second"]',
                "enabled = true",
            ].join("\n"),
            { inference: (real) => ({ models: real.models, providers: accounts }) },
        );
        vi.spyOn(Math, "random").mockReturnValue(0);
        const router = await config.providers.resolve("router", "openai/gpt-5.6-sol");
        if (router === null) throw new Error("Missing configured router.");
        routed = await router.session("routed-codex", { instructions: "test" });
        const result: SessionEvent[] = [];
        for await (const event of routed.run(createRootContext(), {
            context: {
                instructions: "test",
                messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            },
        })) {
            result.push(event);
        }
        expect(firstEvents.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message:
                "Codex authentication could not be renewed for this account. Try again; if it keeps failing, sign in to Codex again with the same account.",
            providerError: { type: "authentication", diagnostics: { status: 401 } },
        });
        expect(firstEvents.filter((event) => event.type === "done")).toHaveLength(1);
        expect(
            firstEvents.every((event) =>
                ["block_start", "block_reset", "done"].includes(event.type),
            ),
        ).toBe(true);
        for (const secret of [root, authFile, staleToken, refreshToken, healthyToken]) {
            expect(JSON.stringify(firstEvents)).not.toContain(secret);
            expect(JSON.stringify(result)).not.toContain(secret);
        }
        expect(JSON.stringify([firstEvents, result])).not.toMatch(
            /invalid_grant|HTTP 400|token refresh|ENOENT/,
        );
        expect(result.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(result.filter((event) => event.type === "done")).toHaveLength(1);
        expect(attempts).toEqual(["stale", "stale", "refresh", "healthy"]);
        expect(await readFile(authFile, "utf8")).toBe(auth);
    } finally {
        await routed?.destroy();
        await config?.closeProviders();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
