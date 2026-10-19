import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { createMobileRelayFixture } from "../support/MobileRelayFixture.js";
import { ScriptedProvider, type ScriptedTurn } from "../support/ScriptedProvider.js";
import { createHappySpawnSessionId } from "../../sources/happy/createHappySpawnSessionId.js";

const ACCOUNT = "phone";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A standalone daemon with its bots, paired through the protocol relay once they exist. */
async function linkedDaemon(
    options: {
        readonly bots?: number;
        readonly relay?: { readonly sessionSubscribe?: boolean };
        readonly script?: ScriptedTurn[];
    } = {},
) {
    const root = await mkdtemp(join(tmpdir(), "happy-mobile-multiplex-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const relay = await createMobileRelayFixture(options.relay);
    cleanups.push(async () => await relay.close());
    const happyHome = join(root, ".happy");
    const providers = new AgentProviders();
    providers.add("gym", new ScriptedProvider(options.script ?? []), "codex");
    const runtime: HappyAgentRuntime = await startHappyAgentRuntime({
        happyHome,
        environment: { HAPPY_HOME_DIR: happyHome, HAPPY_AGENT_HAPPY_SERVER_URL: relay.url },
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
    });
    const server: Server = createServer((request, response) => {
        void runtime.api.handleRequest(
            withAgentDatabase(runtime.ctx.named("test.multiplex-http"), runtime.database),
            request,
            response,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await runtime.close();
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address.");
    const client = new HappyAgentClient({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        token: (await readFile(runtime.configuration.paths.tokenPath, "utf8")).trim(),
    });
    const bots = [];
    for (let index = 0; index < (options.bots ?? 1); index += 1) {
        bots.push((await client.createBot({ name: `Multiplexed bot ${String(index)}` })).bot);
    }
    const pairing = await client.startHappyIntegration();
    relay.authorize(pairing.integration.authorization!.data, ACCOUNT);
    const bot = bots[0]!;
    /** The one remote session that publishes this bot. */
    const sessionOf = (botId: string) => {
        const ids = relay.botSessions(ACCOUNT, botId);
        expect(ids).toHaveLength(1);
        return ids[0]!;
    };
    await vi.waitFor(
        async () => {
            expect((await client.getHappyIntegration()).integration.status).toBe("connected");
            sessionOf(bot.id);
        },
        { timeout: 10_000 },
    );
    return { bot, bots, client, relay, sessionOf };
}

/** Waits until every bot has one remote session, and the machine socket is in each one's room. */
async function everyRoomJoined(
    relay: Awaited<ReturnType<typeof createMobileRelayFixture>>,
    bots: readonly { readonly id: string }[],
) {
    await vi.waitFor(
        () => {
            const rooms = relay.machineRooms(ACCOUNT);
            for (const bot of bots) {
                const ids = relay.botSessions(ACCOUNT, bot.id);
                expect(ids).toHaveLength(1);
                expect(rooms).toContain(ids[0]);
            }
        },
        { timeout: 60_000, interval: 250 },
    );
}

async function messages(client: HappyAgentClient, agentId: string): Promise<string> {
    const history = await client.getMessages(agentId);
    return JSON.stringify(history.runs.flatMap((run) => run.messages));
}

describe("carrying mobile sessions over the machine connection", () => {
    it("creates an unnamed task once through encrypted spawn, preserves its draft, and accepts its first message", async () => {
        const { client, relay } = await linkedDaemon();
        const machineId = relay.machines.get(ACCOUNT)!;
        const method = `${machineId}:spawn-happy-session`;
        const request = {
            type: "happy-agent-spawn",
            clientRequestId: "mobile-task-creation",
            target: { kind: "task" },
            agentConfiguration: {
                type: "happy-agent",
                modelId: "gym/model",
                providerId: "gym",
                effort: "medium",
                permissionMode: "read_only",
            },
        };
        let result: unknown;
        await vi.waitFor(
            async () => {
                result = await relay.callRpc(ACCOUNT, method, request);
                expect(result).toMatchObject({ type: "success" });
            },
            { timeout: 10_000 },
        );
        const taskId = createHappySpawnSessionId(machineId, "mobile-task-creation:task");
        const created = await client.getTask(taskId);
        expect(created.task).toMatchObject({
            name: "New Task",
            ownerUserId: null,
            creatorAgentId: null,
            workspaceId: createHappySpawnSessionId(machineId, "mobile-task-creation:workspace"),
            agent: { id: createHappySpawnSessionId(machineId, "mobile-task-creation") },
            canArchive: true,
        });
        const sid = relay.taskSessions(ACCOUNT, taskId)[0]!;
        expect(result).toEqual({ type: "success", sessionId: sid });
        expect(relay.sessionMetadata(ACCOUNT, sid)).toMatchObject({
            task: {
                id: taskId,
                owner: null,
                canArchive: true,
                orderKey: created.membership!.orderKey,
            },
            draft: { text: "", permissionMode: "read_only", modelId: "gym/model" },
        });
        await client.saveAgentDraft(created.task.agent.id, {
            draft: {
                text: "Keep this edit",
                permissionMode: "auto",
                modelId: "gym/model",
                providerId: "gym",
                effort: "medium",
                serviceTier: null,
            },
            updatedAt: Date.now() + 1,
        });
        expect(await relay.callRpc(ACCOUNT, method, request)).toEqual(result);
        expect(
            await Promise.all([
                relay.callRpc(ACCOUNT, method, request),
                relay.callRpc(ACCOUNT, method, request),
            ]),
        ).toEqual([result, result]);
        expect((await client.getAgentDraft(created.task.agent.id)).draft.value?.text).toBe(
            "Keep this edit",
        );
        expect(relay.taskSessions(ACCOUNT, taskId)).toEqual([sid]);
        await vi.waitFor(() => expect(relay.rpcMethods(ACCOUNT)).toContain(`${sid}:readFile`));
        // Task workspaces resolve from the task catalog, not a missing project association.
        expect(
            await relay.callRpc(ACCOUNT, `${sid}:readFile`, { path: "does-not-exist.txt" }),
        ).toMatchObject({
            success: false,
            code: "missing",
        });
        relay.deliver(ACCOUNT, taskId, "My first mobile task message.");
        await vi.waitFor(
            async () => {
                expect(await messages(client, created.task.agent.id)).toContain(
                    "My first mobile task message.",
                );
            },
            { timeout: 10_000 },
        );
        const current = (await client.getTask(taskId)).task;
        await client.archiveTask(taskId, { ifMatch: current.version });
        expect(await relay.callRpc(ACCOUNT, method, request)).toEqual({
            type: "error",
            errorMessage: "That task was archived.",
        });
    }, 30_000);

    it("sends and receives every session on the machine socket, with no socket per session", async () => {
        const { bot, client, relay, sessionOf } = await linkedDaemon({
            script: [
                [
                    { type: "text_start" },
                    { type: "text_delta", delta: "Answered over the machine socket." },
                    { type: "text_end" },
                    { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
                ],
            ],
        });
        const sid = sessionOf(bot.id);
        await vi.waitFor(
            () => {
                expect(relay.machineRooms(ACCOUNT)).toContain(sid);
                expect(relay.rpcMethods(ACCOUNT)).toContain(`${sid}:abort`);
            },
            { timeout: 10_000 },
        );
        expect(relay.sessionSockets(ACCOUNT)).toBe(0);

        relay.deliver(ACCOUNT, bot.id, "Hello from the phone.");
        await vi.waitFor(
            async () => {
                expect(await messages(client, bot.agent.id)).toContain("Hello from the phone.");
                expect(JSON.stringify(relay.outgoing.get(sid) ?? [])).toContain(
                    "Answered over the machine socket.",
                );
            },
            { timeout: 10_000 },
        );
        expect(relay.sessionSockets(ACCOUNT)).toBe(0);
    }, 30_000);

    it("gives each session its own socket when Happy never answers a subscription", async () => {
        const { bot, client, relay, sessionOf } = await linkedDaemon({
            relay: { sessionSubscribe: false },
        });
        const sid = sessionOf(bot.id);
        // An older server is recognized only by its silence, after the probe's wait.
        await vi.waitFor(
            () => {
                expect(relay.sessionSockets(ACCOUNT)).toBeGreaterThanOrEqual(1);
                expect(relay.rpcMethods(ACCOUNT)).toContain(`${sid}:abort`);
            },
            { timeout: 15_000 },
        );
        expect(relay.machineRooms(ACCOUNT)).toEqual([]);
        relay.deliver(ACCOUNT, bot.id, "Hello over a session socket.");
        await vi.waitFor(
            async () =>
                expect(await messages(client, bot.agent.id)).toContain(
                    "Hello over a session socket.",
                ),
            { timeout: 10_000 },
        );
    }, 40_000);

    it("resubscribes after a reconnect and recovers a phone edit made while it was away", async () => {
        const { bot, client, relay, sessionOf } = await linkedDaemon();
        const sid = sessionOf(bot.id);
        await vi.waitFor(() => expect(relay.machineRooms(ACCOUNT)).toContain(sid), {
            timeout: 10_000,
        });
        const subscribedBefore = relay.subscriptions.length;
        relay.dropMachineSocket(ACCOUNT);
        await vi.waitFor(() => expect(relay.machineRooms(ACCOUNT)).toEqual([]));
        // Happy does not replay updates, so this edit reaches nobody until the daemon asks.
        const draft = {
            text: "Typed while the computer was offline.",
            providerId: "gym",
            modelId: "gym/model",
            effort: "medium",
            serviceTier: null,
            permissionMode: "full_access" as const,
        };
        relay.updateMetadata(ACCOUNT, bot.id, { draft, draftUpdatedAt: 500 });
        await vi.waitFor(
            async () => {
                expect(
                    relay.subscriptions
                        .slice(subscribedBefore)
                        .some((entry) => entry.kind === "subscribe" && entry.sids.includes(sid)),
                ).toBe(true);
                expect(relay.machineRooms(ACCOUNT)).toContain(sid);
                expect((await client.getAgentDraft(bot.agent.id)).draft).toEqual({
                    value: draft,
                    updatedAt: 500,
                });
            },
            { timeout: 15_000 },
        );
        expect(relay.sessionSockets(ACCOUNT)).toBe(0);
    }, 40_000);

    it("publishes more than 64 sessions when Happy carries them on the machine socket", async () => {
        const { bots, relay } = await linkedDaemon({ bots: 70 });
        await everyRoomJoined(relay, bots);
        expect(relay.sessionSockets(ACCOUNT)).toBe(0);
    }, 120_000);

    it("keeps at most 64 session sockets when a reconnect reaches a server that cannot carry them", async () => {
        const { bots, relay } = await linkedDaemon({ bots: 70 });
        await everyRoomJoined(relay, bots);
        relay.answerSubscriptions(false);
        relay.dropMachineSocket(ACCOUNT);
        await vi.waitFor(
            () => {
                expect(relay.sessionSockets(ACCOUNT)).toBe(64);
                expect(relay.machineRooms(ACCOUNT)).toEqual([]);
            },
            { timeout: 30_000, interval: 250 },
        );
        // The sessions beyond the cap were let go before any socket opened.
        expect(relay.peakSessionSockets(ACCOUNT)).toBe(64);
        // A requested task is a standing conversation too; a full bot catalog must not leave
        // its creation permanently pending on an older relay's bounded transport.
        const machineId = relay.machines.get(ACCOUNT)!;
        await vi.waitFor(
            async () =>
                expect(
                    await relay.callRpc(ACCOUNT, `${machineId}:spawn-happy-session`, {
                        type: "happy-agent-spawn",
                        clientRequestId: "task-at-capacity",
                        target: { kind: "task" },
                    }),
                ).toMatchObject({ type: "success" }),
            { timeout: 10_000 },
        );
        expect(relay.sessionSockets(ACCOUNT)).toBeLessThanOrEqual(64);
        expect(relay.peakSessionSockets(ACCOUNT)).toBe(64);
    }, 120_000);

    it("publishes the sessions the cap left out once a reconnect reaches a server that carries them", async () => {
        const { bots, relay } = await linkedDaemon({
            bots: 70,
            relay: { sessionSubscribe: false },
        });
        await vi.waitFor(() => expect(relay.sessionSockets(ACCOUNT)).toBe(64), {
            timeout: 60_000,
            interval: 250,
        });
        relay.answerSubscriptions(true);
        relay.dropMachineSocket(ACCOUNT);
        await everyRoomJoined(relay, bots);
        await vi.waitFor(() => expect(relay.sessionSockets(ACCOUNT)).toBe(0));
    }, 120_000);

    it("leaves a session's room when it is archived, and every room when unlinked", async () => {
        const { bot, bots, client, relay, sessionOf } = await linkedDaemon({ bots: 2 });
        // Startup restores sessions one after another, so the second may still be publishing.
        await everyRoomJoined(relay, bots);
        const sid = sessionOf(bot.id);
        const other = sessionOf(bots[1]!.id);
        await client.archiveBot(bot.id, { ifMatch: bot.version });
        await vi.waitFor(
            () => {
                expect(relay.machineRooms(ACCOUNT)).not.toContain(sid);
                expect(relay.rpcMethods(ACCOUNT)).not.toContain(`${sid}:abort`);
                expect(relay.endedSessions).toContain(sid);
            },
            { timeout: 10_000 },
        );
        expect(relay.machineRooms(ACCOUNT)).toContain(other);

        await client.disconnectHappyIntegration();
        expect(
            relay.subscriptions.some(
                (entry) => entry.kind === "unsubscribe" && entry.sids.includes(other),
            ),
        ).toBe(true);
        expect(relay.endedSessions).toContain(other);
    }, 30_000);
});
