import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentDatabaseRun,
    openAgentSQLiteDatabase,
    withAgentDatabase,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it } from "vitest";
import { testConfigRootedAt } from "../support/configModule.js";

it("maps the actual native Codex credential to an opaque ID and freezes it when login storage changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-codex-account-"));
    const authFile = join(root, "auth.json");
    const auth = async (account: string) =>
        await writeFile(
            authFile,
            JSON.stringify({
                tokens: { access_token: "synthetic-private-access", account_id: account },
            }),
        );
    await auth("native-account-A");
    const wire: string[] = [];
    const upstream = createServer(async (request, response) => {
        request.resume();
        wire.push(request.headers["chatgpt-account-id"] as string);
        if (wire.length === 2) {
            await auth("native-account-B");
            response.writeHead(401, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    error: { type: "authentication_error", message: "Synthetic expired login." },
                }),
            );
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
            'data: {"type":"response.completed","response":{"id":"native-response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
        );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
    const config = await testConfigRootedAt(
        root,
        `[providers]\ndefault_enable = false\n[providers.native]\ntype = "codex"\nenabled = true\ncredential_isolation = true\nauth_file = ${JSON.stringify(authFile)}\nbase_url = "http://127.0.0.1:${address.port}/backend-api"\ntransport = "sse"\n[settings]\ninference_max_retries = 0\n`,
    );
    const database = await openAgentSQLiteDatabase(join(root, "agent.sqlite"));
    const ctx = withAgentDatabase(createRootContext(), database.database);
    for (const [, migrate] of config.migrations) await migrate(ctx, database.database);
    const model = "openai/gpt-5.6-sol";
    const provider = (await config.providers.resolve("native", model))!;
    const session = await provider.session("native-session", { instructions: "Synthetic test." });
    const run = async (operation: string, concrete = session) => {
        config.beginExecutionObservation(concrete.id, operation, "inference");
        try {
            const events = [];
            for await (const event of concrete.run(ctx, {
                model,
                context: {
                    instructions: "Synthetic test.",
                    messages: [{ role: "user", content: [{ type: "text", text: operation }] }],
                },
            }))
                events.push(event);
            const attempts = config.executionObservation(concrete.id, operation)!;
            expect(attempts).toHaveLength(1);
            expect(attempts[0]!.mode).toMatchObject({
                providerId: "native",
                providerType: "codex",
                modelId: model,
                account: { id: expect.any(String) },
            });
            return { attempt: attempts[0]!, events };
        } finally {
            config.endExecutionObservation(concrete.id, operation);
        }
    };
    let fresh: typeof session | undefined;
    try {
        const a = await run("A succeeds");
        const failedA = await run("A fails after storage changes to B");
        expect(failedA.events.at(-1)).toMatchObject({ type: "done", state: "error" });
        expect(failedA.attempt.mode.account).toEqual(a.attempt.mode.account);
        expect(failedA.attempt.errorCode).toBe("authentication_failed");
        const newProvider = (await config.providers.resolve("native", model))!;
        fresh = await newProvider.session("fresh-session", { instructions: "Synthetic test." });
        const b = await run("A fresh session uses B", fresh);
        expect(b.attempt.mode.account).not.toEqual(a.attempt.mode.account);
        expect(wire).toEqual(["native-account-A", "native-account-A", "native-account-B"]);
        for (const marker of [
            "native-account-A",
            "native-account-B",
            authFile,
            "synthetic-private-access",
        ])
            expect(JSON.stringify([a, failedA, b])).not.toContain(marker);
        // A failure before native compaction dispatch must release the claimed observation,
        // including direct factory callers that do not have a daemon settlement hook.
        await agentDatabaseRun(ctx.db, sql`DROP TABLE happy_agent_config_native_accounts`);
        config.beginExecutionObservation(fresh.id, "storage-failure", "compaction");
        await expect(
            fresh.compact(ctx, {
                model,
                context: { instructions: "Synthetic test.", messages: [] },
            }),
        ).rejects.toThrow("The private account identity could not be resolved.");
        expect(config.executionObservation(fresh.id, "storage-failure")).toBeUndefined();
        expect(wire).toHaveLength(3);
        config.beginExecutionObservation(fresh.id, "after-storage-failure", "compaction");
        expect(config.executionObservation(fresh.id, "after-storage-failure")).toEqual([]);
        config.endExecutionObservation(fresh.id, "after-storage-failure");
    } finally {
        await fresh?.destroy();
        await session.destroy();
        await config.closeProviders();
        await database.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
