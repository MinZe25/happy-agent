import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { createHostCompute } from "@slopus/happy-agent-compute";
import { detach } from "@steve.kite/stdlib";
import {
    HappyAgentClient,
    type EventStreamFrame,
    type HappyAgentEvent,
    type Message,
} from "@slopus/happy-agent-client";
import { describe, expect, it, vi } from "vitest";

import { ApiEventJournal, type ApiEvent } from "../../sources/api/ApiEventJournal.js";

import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { diagnostic, diagnosticMessage, diagnosticText } from "../support/credentialDiagnostic.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

/** These canonical-record tests prove disclosure, not provider credential capture. */
describe.each(["standalone", "team", "team-with-unresolved-owner"] as const)(
    "%s credential diagnostic disclosure",
    (deployment) => {
        const isTeam = deployment !== "standalone";
        const mayDisclose = deployment !== "team-with-unresolved-owner";
        it("projects history, concurrent live readers and replay without changing durable records or cursors", async () => {
            const root = await mkdtemp(join(tmpdir(), "credential-api-"));
            let runtime: HappyAgentRuntime | undefined;
            let server: Server | undefined;
            let journal: ApiEventJournal | undefined;
            let injectAtHello: (() => void) | undefined;
            const append = ApiEventJournal.prototype.append;
            // Projection-only fault injection: observe the real journal without changing append.
            const appendSpy = vi
                .spyOn(ApiEventJournal.prototype, "append")
                .mockImplementation(function (
                    this: ApiEventJournal,
                    ...args: Parameters<typeof append>
                ) {
                    journal = this;
                    return append.apply(this, args);
                });
            const streams: Array<Awaited<ReturnType<typeof openStream>>> = [];
            const { privateKey, publicKey } = generateKeyPairSync("ed25519");
            const tokenFor = (subject: string) => {
                const input = [
                    { alg: "EdDSA", typ: "JWT" },
                    {
                        sub: subject,
                        iss: "https://diagnostic.test",
                        aud: "diagnostic-tests",
                        exp: Math.floor(Date.now() / 1000) + 3600,
                    },
                ]
                    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
                    .join(".");
                return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
            };
            const configPath = join(
                root,
                process.platform === "darwin"
                    ? "Happy/Config/happy.toml"
                    : "happy/config/happy.toml",
            );
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                deployment === "standalone"
                    ? ""
                    : `
[feature.team]
enabled = true
host = "127.0.0.1"
port = 0
authentication = "jwt"
owner_user_id = "${mayDisclose ? "alice" : "not-onboarded-owner"}"
[feature.team.jwt]
name = "Diagnostic test sign-in"
authorization_url = "https://diagnostic.test/authorize"
token_url = "https://diagnostic.test/token"
client_id = "diagnostic-tests"
issuer = "https://diagnostic.test"
audience = "diagnostic-tests"
algorithms = ["EdDSA"]
public_key = """
${publicKey.export({ type: "spki", format: "pem" }).toString()}"""
`,
            );
            const stop = async () => {
                await Promise.all(streams.splice(0).map((stream) => stream.close()));
                server?.closeAllConnections();
                if (server !== undefined)
                    await new Promise<void>((resolve) => server!.close(() => resolve()));
                server = undefined;
                await runtime?.close();
                runtime = undefined;
            };
            const start = async () => {
                journal = undefined;
                let endpoint = "";
                const providers = new AgentProviders();
                providers.add("gym", new ScriptedProvider([]), "codex");
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
                        HAPPY_HOME_DIR: join(root, "credentials", "happy"),
                        CODEX_HOME: join(root, "credentials", "codex"),
                        CLAUDE_CONFIG_DIR: join(root, "credentials", "claude"),
                        GROK_HOME: join(root, "credentials", "grok"),
                        OPENAI_API_KEY: undefined,
                        ANTHROPIC_API_KEY: undefined,
                        ANTHROPIC_AUTH_TOKEN: undefined,
                        CLAUDE_CODE_OAUTH_TOKEN: undefined,
                        XAI_API_KEY: undefined,
                    },
                    inference: {
                        providers,
                        models: [
                            {
                                id: "gym/model",
                                providerId: "gym",
                                name: "Gym",
                                defaultEffort: "medium",
                                effortLevels: ["medium"],
                            },
                        ],
                    },
                    onPrepared: async (prepared) => {
                        server = createServer((request, response) => {
                            const write = response.write.bind(response);
                            response.write = ((...args: Parameters<ServerResponse["write"]>) => {
                                const written = write(...args);
                                if (
                                    typeof args[0] === "string" &&
                                    args[0].startsWith("event: hello\n")
                                ) {
                                    const inject = injectAtHello;
                                    injectAtHello = undefined;
                                    inject?.();
                                }
                                return written;
                            }) as ServerResponse["write"];
                            void prepared.api.handleRequest(
                                prepared.context("test.http"),
                                request,
                                response,
                            );
                        });
                        await new Promise<void>((resolve) =>
                            server!.listen(0, "127.0.0.1", resolve),
                        );
                        const address = server.address();
                        if (address === null || typeof address === "string")
                            throw new Error("Missing fixture address.");
                        endpoint = `http://127.0.0.1:${address.port}`;
                    },
                });
                return {
                    owner: new HappyAgentClient({
                        endpoint,
                        token: isTeam ? tokenFor("alice") : runtime.api.token()!,
                    }),
                    other: new HappyAgentClient({
                        endpoint,
                        token: isTeam ? tokenFor("bob") : "invalid-api-token",
                    }),
                };
            };
            try {
                let { owner, other } = await start();
                if (isTeam) {
                    for (const [client, name] of [
                        [owner, "Alice"],
                        [other, "Bob"],
                    ] as const) {
                        const { profile } = await client.getProfile();
                        await client.updateProfile({ name }, { ifMatch: profile.version });
                    }
                }
                const workspace = join(root, "workspace");
                await mkdir(workspace);
                const { project } = await owner.registerProject({ path: workspace });
                const { agent } = await owner.createAgent({
                    workspaceId: project.id,
                    title: "Diagnostic disclosure",
                });
                await vi.waitFor(async () => {
                    expect((await owner.getProject(project.id)).project.worktreeSupport).toBe(
                        "unsupported",
                    );
                });
                await vi.waitFor(async () => {
                    expect(
                        (await owner.getAgent(agent.id)).slashCommands?.map(
                            (command) => command.name,
                        ),
                    ).toEqual(["compact"]);
                });
                // The built-in bot discovers its catalog independently of this fixture agent.
                // Wait for its public creation snapshot before testing reader-only mutations.
                const { bots } = await owner.listBots();
                const chief = bots.find((bot) => bot.systemKey === "chief_of_staff");
                expect(chief).toBeDefined();
                await vi.waitFor(() => {
                    const events = journal!.replay(undefined, undefined, 10_000)!.events;
                    expect(events).toContainEqual(
                        expect.objectContaining({
                            type: "agent.slash_commands.updated",
                            payload: expect.objectContaining({ agentId: chief!.agent.id }),
                        }),
                    );
                    expect(events).toContainEqual(
                        expect.objectContaining({
                            type: "agent.created",
                            payload: expect.objectContaining({
                                agent: expect.objectContaining({ id: chief!.agent.id }),
                            }),
                        }),
                    );
                });
                const ctx = withAgentDatabase(
                    runtime!.ctx.named("test.diagnostic-record"),
                    runtime!.database,
                );
                const history = runtime!.modules.history;
                const record = {
                    ...diagnosticMessage,
                    recordId: "diagnosticmessage",
                    runId: "diagnosticrun",
                };
                const original = structuredClone(record);
                await history.beginMaintenanceRun(ctx, agent.id, record.runId, record.at);
                const before = (await owner.getEvents()).latestCursor;
                const ownerLive = await openStream(owner, before);
                streams.push(ownerLive);
                const memberLive = isTeam ? await openStream(other, before) : undefined;
                if (memberLive !== undefined) streams.push(memberLive);

                await history.record(ctx, agent.id, record);
                await history.finishMaintenanceRun(
                    ctx,
                    agent.id,
                    record.runId,
                    "failed",
                    record.at + 1,
                );
                const ownerEvent = await ownerLive.message(record.recordId);
                expectCaller(ownerEvent.payload.message, mayDisclose);
                if (memberLive !== undefined) {
                    const memberEvent = await memberLive.message(record.recordId);
                    expect(memberEvent.cursor).toBe(ownerEvent.cursor);
                    expectWithheld(memberEvent.payload.message);
                }
                const ownerHistory = await owner.getMessages(agent.id);
                expectCaller(ownerHistory.runs[0]!.messages[0]!, mayDisclose);
                const retainedHighWater = journal!.cursor();
                const retained = journal!.replay(undefined, retainedHighWater, 10_000)!.events;
                const retainedValues = structuredClone(retained);
                expect(
                    retained.find((event) => event.cursor === ownerEvent.cursor)?.payload,
                ).toMatchObject({
                    message: { error: diagnostic },
                });
                if (isTeam) {
                    const memberHistory = await other.getMessages(agent.id);
                    expect(memberHistory.cursor >= ownerHistory.cursor).toBe(true);
                    expect(memberHistory.runs[0]!.messages[0]!.id).toBe(
                        ownerHistory.runs[0]!.messages[0]!.id,
                    );
                    expect(memberHistory.runs[0]!.messages[0]!.content).toEqual(
                        ownerHistory.runs[0]!.messages[0]!.content,
                    );
                    expectWithheld(memberHistory.runs[0]!.messages[0]!);
                    const [ownerPull, memberPull] = await Promise.all([
                        owner.getEvents({ after: before, until: retainedHighWater }),
                        other.getEvents({ after: before, until: retainedHighWater }),
                    ]);
                    expect(memberPull.events.map((event) => event.cursor)).toEqual(
                        ownerPull.events.map((event) => event.cursor),
                    );
                    const messageEvent = memberPull.events.find(
                        (event) => event.type === "message.created",
                    );
                    expect(messageEvent?.type).toBe("message.created");
                    if (messageEvent?.type === "message.created")
                        expectWithheld(messageEvent.payload.message);
                    const replay = await openStream(other, before);
                    streams.push(replay);
                    expectWithheld((await replay.message(record.recordId)).payload.message);
                } else {
                    await expect(other.getMessages(agent.id)).rejects.toMatchObject({
                        status: 401,
                    });
                    await expect(other.getEvents()).rejects.toMatchObject({ status: 401 });
                }
                const afterReaders = journal!.replay(undefined, retainedHighWater, 10_000)!.events;
                expect(afterReaders).toHaveLength(retained.length);
                expect(afterReaders).toEqual(retainedValues);
                for (const [index, event] of retained.entries())
                    expect(afterReaders[index]).toBe(event);
                // Project registration's detached Git probe can finish during these reads.
                for (const event of journal!.replay(retainedHighWater, undefined, 10_000)!.events) {
                    expect(["project.updated", "workspace.updated"]).toContain(event.type);
                    const serialized = JSON.stringify(event);
                    for (const marker of [
                        "PRIVATE_PROVIDER_TOKEN",
                        "private-login-host",
                        "private-login-command",
                        '"credentialSource"',
                        '"host"',
                        '"commands"',
                        '"type":"configuration"',
                    ])
                        expect(serialized).not.toContain(marker);
                }

                const updatedPayload = {
                    ...ownerEvent.payload,
                    message: { ...ownerEvent.payload.message, error: diagnostic },
                };
                const beforeFlush = journal!.cursor();
                let injected: ApiEvent | undefined;
                injectAtHello = () => {
                    injected = journal!.append("message.updated", updatedPayload);
                };
                const flushReader = await openStream(isTeam ? other : owner, beforeFlush);
                streams.push(flushReader);
                expect(flushReader.hello.cursor >= beforeFlush).toBe(true);
                expect(injected).toBeDefined();
                const liveUpdate = journal!.append("message.updated", updatedPayload);
                const flushed = await flushReader.message(record.recordId, "message.updated");
                expect(flushed.cursor).toBe(injected!.cursor);
                expect(flushed.cursor > flushReader.hello.cursor).toBe(true);
                expect(flushed.cursor < liveUpdate.cursor).toBe(true);
                expectCaller(flushed.payload.message, !isTeam);
                const deliveredLive = await flushReader.message(record.recordId, "message.updated");
                expect(deliveredLive.cursor).toBe(liveUpdate.cursor);
                expectCaller(deliveredLive.payload.message, !isTeam);
                const ownerUpdated = await ownerLive.message(record.recordId, "message.updated");
                expect(ownerUpdated.cursor).toBe(injected!.cursor);
                expectCaller(ownerUpdated.payload.message, mayDisclose);
                const updatedReplay = await openStream(isTeam ? other : owner, beforeFlush);
                streams.push(updatedReplay);
                expectCaller(
                    (await updatedReplay.message(record.recordId, "message.updated")).payload
                        .message,
                    !isTeam,
                );
                expect(injected!.payload).toEqual(updatedPayload);
                expect(liveUpdate.payload).toEqual(updatedPayload);
                expect(await history.message(ctx, agent.id, record.recordId)).toEqual(original);
                expect(record).toEqual(original);
                await stop();
                ({ owner, other } = await start());
                expectCaller(
                    (await owner.getMessages(agent.id)).runs[0]!.messages[0]!,
                    mayDisclose,
                );
                if (isTeam)
                    expectWithheld((await other.getMessages(agent.id)).runs[0]!.messages[0]!);
                // A real post-restart mutation identifies this runtime's new journal instance.
                const { profile } = await owner.getProfile();
                await owner.updateProfile(
                    { name: "Alice after restart" },
                    { ifMatch: profile.version },
                );
                expect(journal).toBeDefined();
                await expect(owner.getEvents({ after: before })).rejects.toMatchObject({
                    status: 409,
                    code: "cursor_unavailable",
                });
                const gap = await openStream(owner, before);
                streams.push(gap);
                expect(gap.hello).toMatchObject({ gap: true, resumed: false });
                const fresh = await openStream(
                    isTeam ? other : owner,
                    (await owner.getEvents()).latestCursor,
                );
                streams.push(fresh);
                journal!.append("message.updated", updatedPayload);
                expectCaller(
                    (await fresh.message(record.recordId, "message.updated")).payload.message,
                    !isTeam,
                );
            } finally {
                await stop();
                appendSpy.mockRestore();
                await rm(root, { recursive: true, force: true });
            }
        }, 60_000);
    },
);

function expectCaller(message: Message, mayDisclose: boolean) {
    if (mayDisclose) expect(message).toMatchObject({ error: diagnostic });
    else expectWithheld(message);
}

function expectWithheld(message: Message) {
    expect(message).toMatchObject({
        id: "diagnosticmessage",
        role: "service",
        content: [{ type: "text", text: diagnosticText }],
        error: {
            code: diagnostic.code,
            mode: diagnostic.mode,
            credentialSource: null,
            recovery: { actions: diagnostic.recovery.actions },
        },
    });
    expect(message).not.toHaveProperty("error.recovery.commands");
    const serialized = JSON.stringify(message);
    for (const marker of ["PRIVATE_PROVIDER_TOKEN", "private-login-host", "private-login-command"])
        expect(serialized).not.toContain(marker);
}

async function openStream(client: HappyAgentClient, after: string) {
    const controller = new AbortController();
    const iterator = client.streamEvents({
        after,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    const first = await iterator.next();
    if (first.done || first.value.kind !== "hello") throw new Error("Expected a stream hello.");
    return {
        hello: first.value.hello,
        async message(
            id: string,
            type: "message.created" | "message.updated" = "message.created",
        ): Promise<Extract<HappyAgentEvent, { type: "message.created" | "message.updated" }>> {
            for (let count = 0; count < 64; count += 1) {
                const next: IteratorResult<EventStreamFrame> = await iterator.next();
                if (next.done) break;
                if (
                    next.value.kind === "event" &&
                    (next.value.event.type === "message.created" ||
                        next.value.event.type === "message.updated") &&
                    next.value.event.type === type &&
                    next.value.event.payload.message.id === id
                )
                    return next.value.event;
            }
            throw new Error("The expected message event did not arrive within the bounded stream.");
        },
        async close() {
            controller.abort();
            await iterator.return(undefined).catch(() => undefined);
        },
    };
}
