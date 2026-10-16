import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { withAgentDatabase } from "@slopus/happy-agent-base";
import { createHostCompute } from "@slopus/happy-agent-compute";
import { detach } from "@steve.kite/stdlib";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";

/** A real runtime with its own credentials, HTTP transport and database, without inference overrides. */
export async function diagnosticRuntime(toml: string) {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-runtime-"));
    let runtime: HappyAgentRuntime | undefined;
    let server: Server | undefined;
    const configPath = join(
        root,
        process.platform === "darwin" ? "Happy/Config/happy.toml" : "happy/config/happy.toml",
    );
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, toml);
    const close = async () => {
        server?.closeAllConnections();
        if (server !== undefined)
            await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        await runtime?.close();
        runtime = undefined;
        await rm(root, { recursive: true, force: true });
    };
    try {
        let endpoint = "";
        runtime = await startHappyAgentRuntime({
            happyHome: join(root, ".happy"),
            compute: async (ctx, options) =>
                createHostCompute({
                    ctx: detach(ctx).named("test.diagnostic-compute"),
                    ...options,
                    home: join(root, "home"),
                    environment: { HOME: join(root, "home") },
                }),
            environment: {
                HOME: join(root, "home"),
                CODEX_HOME: join(root, "codex"),
                CLAUDE_CONFIG_DIR: join(root, "claude"),
                GROK_HOME: join(root, "grok"),
                OPENAI_API_KEY: undefined,
                ANTHROPIC_API_KEY: undefined,
                ANTHROPIC_AUTH_TOKEN: undefined,
                CLAUDE_CODE_OAUTH_TOKEN: undefined,
                XAI_API_KEY: undefined,
            },
            onPrepared: async (prepared) => {
                server = createServer((request, response) => {
                    void prepared.api.handleRequest(
                        prepared.context("test.http"),
                        request,
                        response,
                    );
                });
                await new Promise<void>((resolve, reject) => {
                    server!.once("error", reject);
                    server!.listen(0, "127.0.0.1", resolve);
                });
                const address = server.address();
                if (address === null || typeof address === "string")
                    throw new Error("Missing fixture address.");
                endpoint = `http://127.0.0.1:${address.port}`;
            },
        });
        const client = new HappyAgentClient({ endpoint, token: runtime.api.token()! });
        const agent = (await client.listBots()).bots.find((bot) => bot.isAdmin)?.agent;
        return {
            runtime,
            client,
            endpoint,
            agent,
            ctx: withAgentDatabase(runtime.ctx.named("test.diagnostics"), runtime.database),
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
