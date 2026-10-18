import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient, type HappyAgentEvent } from "@slopus/happy-agent-client";
import { createHostCompute } from "@slopus/happy-agent-compute";
import { detach } from "@steve.kite/stdlib";
import { expect, vi } from "vitest";
import { ApiEventJournal } from "../../sources/api/ApiEventJournal.js";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";

export const writerText = "Authentication failed.\n\nRetry this conversation.";
export const writerMode = {
    providerId: "private_account",
    modelId: "openai/gpt-5.6-sol",
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto" as const,
};

/** Real configured provider, HTTP transport, persistence and JWT principals; no inference override. */
export async function credentialWriterRuntime(
    authority: "owner" | "member" | "unresolved",
    options: { providerConfiguration?: string; defaultModel?: string } = {},
) {
    const root = await mkdtemp(join(tmpdir(), "credential-writer-"));
    let runtime: HappyAgentRuntime | undefined;
    let server: Server | undefined;
    let journal: ApiEventJournal | undefined;
    let injectAtHello: (() => void) | undefined;
    const streams: Array<Awaited<ReturnType<typeof openCredentialStream>>> = [];
    const append = ApiEventJournal.prototype.append;
    const observer = vi.spyOn(ApiEventJournal.prototype, "append").mockImplementation(function (
        this: ApiEventJournal,
        ...args: Parameters<typeof append>
    ) {
        journal = this;
        return append.apply(this, args);
    });
    const requests: Array<{
        method: string | undefined;
        path: string | undefined;
        sessionId: string | string[] | undefined;
    }> = [];
    const providerServer = createServer((request, response) => {
        requests.push({
            method: request.method,
            path: request.url,
            sessionId: request.headers["session-id"],
        });
        request.resume();
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ error: { type: "authentication_error", message: writerText } }),
        );
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const token = (subject: string) => {
        const input = [
            { alg: "EdDSA", typ: "JWT" },
            {
                sub: subject,
                iss: "https://writer.test",
                aud: "writer-tests",
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
        ]
            .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
            .join(".");
        return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    };
    const stop = async () => {
        await Promise.all(streams.splice(0).map((stream) => stream.close()));
        server?.closeAllConnections();
        if (server !== undefined)
            await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        await runtime?.close();
        runtime = undefined;
    };
    const close = async () => {
        await stop();
        observer.mockRestore();
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => providerServer.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    };
    const start = async () => {
        journal = undefined;
        let endpoint = "";
        runtime = await startHappyAgentRuntime({
            happyHome: join(root, ".happy"),
            compute: async (ctx, options) =>
                createHostCompute({
                    ctx: detach(ctx).named("test.writer-compute"),
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
                    const write = response.write.bind(response);
                    response.write = ((...args: Parameters<ServerResponse["write"]>) => {
                        const written = write(...args);
                        if (typeof args[0] === "string" && args[0].startsWith("event: hello\n")) {
                            const inject = injectAtHello;
                            injectAtHello = undefined;
                            inject?.();
                        }
                        return written;
                    }) as ServerResponse["write"];
                    void prepared.api.handleRequest(
                        prepared.context("test.writer-http"),
                        request,
                        response,
                    );
                });
                await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
                const address = server.address();
                if (address === null || typeof address === "string")
                    throw new Error("Missing API fixture address.");
                endpoint = `http://127.0.0.1:${address.port}`;
            },
        });
        return {
            owner: new HappyAgentClient({ endpoint, token: token("alice") }),
            reader: new HappyAgentClient({
                endpoint,
                token: token(authority === "member" ? "bob" : "alice"),
            }),
        };
    };
    try {
        await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
        const address = providerServer.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing provider fixture address.");
        const configPath = join(
            root,
            process.platform === "darwin" ? "Happy/Config/happy.toml" : "happy/config/happy.toml",
        );
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            `
[node]
name = "Private writer host"
${
    options.providerConfiguration ??
    `[providers]
default_enable = false
[providers.private_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-writer-key"
base_url = "http://127.0.0.1:${address.port}/v1"
transport = "sse"`
}
[defaults]
provider = "private_account"
model = "${options.defaultModel ?? "openai/gpt-5.6-sol"}"
[settings]
inference_max_retries = 0
[feature.team]
enabled = true
host = "127.0.0.1"
port = 0
authentication = "jwt"
owner_user_id = "${authority === "unresolved" ? "not-onboarded-owner" : "alice"}"
[feature.team.jwt]
name = "Writer test sign-in"
authorization_url = "https://writer.test/authorize"
token_url = "https://writer.test/token"
client_id = "writer-tests"
issuer = "https://writer.test"
audience = "writer-tests"
algorithms = ["EdDSA"]
public_key = """
${publicKey.export({ type: "spki", format: "pem" }).toString()}"""
`,
        );
        let clients = await start();
        for (const [client, name] of [
            [clients.owner, "Alice"],
            ...(authority === "member" ? [[clients.reader, "Bob"] as const] : []),
        ] as const) {
            const { profile } = await client.getProfile();
            await client.updateProfile({ name }, { ifMatch: profile.version });
        }
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        const { project } = await clients.owner.registerProject({ path: workspace });
        const { agent } = await clients.owner.createAgent({
            workspaceId: project.id,
            title: "Credential writer",
        });
        await vi.waitFor(async () =>
            expect((await clients.owner.getProject(project.id)).project.worktreeSupport).toBe(
                "unsupported",
            ),
        );
        await vi.waitFor(async () =>
            expect(
                (await clients.owner.getAgent(agent.id)).slashCommands?.map(
                    (command) => command.name,
                ),
            ).toEqual(["compact"]),
        );
        return {
            agent,
            project,
            requests,
            get owner() {
                return clients.owner;
            },
            get reader() {
                return clients.reader;
            },
            get runtime() {
                return runtime!;
            },
            get journal() {
                if (journal === undefined) throw new Error("No journal event has been observed.");
                return journal;
            },
            get ctx() {
                return withAgentDatabase(
                    runtime!.ctx.named("test.writer-record"),
                    runtime!.database,
                );
            },
            async restart() {
                await stop();
                clients = await start();
            },
            async stream(client: HappyAgentClient, after: string) {
                const stream = await openCredentialStream(client, after);
                streams.push(stream);
                return stream;
            },
            atHello(inject: () => void) {
                injectAtHello = inject;
            },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}

async function openCredentialStream(client: HappyAgentClient, after: string) {
    const controller = new AbortController();
    const iterator = client.streamEvents({
        after,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    const first = await iterator.next();
    if (first.done || first.value.kind !== "hello") throw new Error("Expected a stream hello.");
    return {
        hello: first.value.hello,
        async message(id: string, type: "message.created" | "message.updated" = "message.created") {
            for (let count = 0; count < 128; count += 1) {
                const next = await iterator.next();
                if (next.done) break;
                if (next.value.kind !== "event") continue;
                const event = next.value.event;
                if (
                    (event.type === "message.created" || event.type === "message.updated") &&
                    event.type === type &&
                    event.payload.message.id === id
                )
                    return event as Extract<
                        HappyAgentEvent,
                        { type: "message.created" | "message.updated" }
                    >;
            }
            throw new Error("Expected message did not arrive within the bounded stream.");
        },
        async close() {
            controller.abort();
            await iterator.return(undefined).catch(() => undefined);
        },
    };
}
