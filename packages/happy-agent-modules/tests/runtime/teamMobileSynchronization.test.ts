import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { createMobileRelayFixture } from "../support/MobileRelayFixture.js";
import { createHappySpawnSessionId } from "../../sources/happy/createHappySpawnSessionId.js";

describe("parallel personal mobile synchronization", () => {
    it("pairs two accounts, attributes phone messages, reconnects both, and unlinks only the caller", async () => {
        const root = await mkdtemp(join(tmpdir(), "team-mobile-sync-"));
        const relay = await createMobileRelayFixture();
        const servers: Server[] = [];
        let runtime: HappyAgentRuntime | undefined;
        try {
            const happyHome = join(root, ".happy");
            const configPath = join(
                root,
                process.platform === "darwin" ? "Happy/Config" : "happy/config",
                "happy.toml",
            );
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                [
                    "[feature.team]",
                    "enabled = true",
                    'host = "127.0.0.1"',
                    "port = 0",
                    'workos_organization_id = "org_mobile"',
                    'owner_workos_user_id = "user_alice"',
                ].join("\n"),
            );
            // A shared CLI credential must not be imported into either personal connection.
            await mkdir(happyHome, { recursive: true });
            const external = JSON.stringify({
                token: "external-must-stay-unused",
                secret: Buffer.alloc(32).toString("base64"),
            });
            await writeFile(join(happyHome, "access.key"), external);
            const { privateKey, publicKey } = await generateKeyPair("RS256");
            const jwk = {
                ...(await exportJWK(publicKey)),
                alg: "RS256",
                kid: "mobile-sync",
                use: "sig",
            };
            const nativeFetch = globalThis.fetch;
            vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
                String(input).includes("api.workos.com/sso/jwks/")
                    ? Promise.resolve(Response.json({ keys: [jwk] }))
                    : nativeFetch(input, init),
            );
            const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
            const token = (subject: string) =>
                new SignJWT({ client_id: clientId, org_id: "org_mobile", sid: "mobile-sync" })
                    .setProtectedHeader({ alg: "RS256", kid: "mobile-sync" })
                    .setIssuer(`https://api.workos.com/user_management/${clientId}`)
                    .setSubject(subject)
                    .setIssuedAt()
                    .setExpirationTime("5m")
                    .sign(privateKey);
            const [aliceToken, bobToken] = await Promise.all([
                token("user_alice"),
                token("user_bob"),
            ]);
            const start = async () => {
                let endpoint = "";
                const providers = new AgentProviders();
                providers.add("gym", new ScriptedProvider([]), "codex");
                runtime = await startHappyAgentRuntime({
                    happyHome,
                    environment: {
                        HAPPY_HOME_DIR: happyHome,
                        HAPPY_AGENT_HAPPY_SERVER_URL: relay.url,
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
                        const server = createServer((request, response) => {
                            void prepared.api.handleRequest(
                                prepared.context("test.mobile-http"),
                                request,
                                response,
                            );
                        });
                        servers.push(server);
                        await new Promise<void>((resolve, reject) => {
                            server.once("error", reject);
                            server.listen(0, "127.0.0.1", resolve);
                        });
                        const address = server.address();
                        if (address === null || typeof address === "string")
                            throw new Error("Missing test address.");
                        endpoint = `http://127.0.0.1:${address.port}`;
                    },
                });
                return {
                    alice: new HappyAgentClient({ endpoint, token: aliceToken }),
                    bob: new HappyAgentClient({ endpoint, token: bobToken }),
                };
            };
            let { alice, bob } = await start();
            const owners: string[] = [];
            for (const [client, name] of [
                [alice, "Alice"],
                [bob, "Bob"],
            ] as const) {
                const initial = await client.getProfile();
                const profile = (
                    await client.updateProfile({ name }, { ifMatch: initial.profile.version })
                ).profile;
                owners.push(profile.userId!);
                expect((await client.getHappyIntegration()).integration.configured).toBe(false);
            }
            expect(relay.machines.size).toBe(0);
            const bot = (await alice.createBot({ name: "Shared mobile bot" })).bot;
            const task = (await alice.createTask({ name: "Alice's task" })).task;
            const bobTask = (await bob.createTask({ name: "Bob's task" })).task;
            const [alicePairing, bobPairing] = await Promise.all([
                alice.startHappyIntegration(),
                bob.startHappyIntegration(),
            ]);
            relay.authorize(alicePairing.integration.authorization!.data, "alice-mobile");
            relay.authorize(bobPairing.integration.authorization!.data, "bob-mobile");
            await vi.waitFor(
                async () => {
                    expect((await alice.getHappyIntegration()).integration.status).toBe(
                        "connected",
                    );
                    expect((await bob.getHappyIntegration()).integration.status).toBe("connected");
                    expect(relay.activeMachines()).toEqual(["alice-mobile", "bob-mobile"]);
                    expect(
                        [...relay.sessions.values()].filter((session) => session.botId === bot.id),
                    ).toHaveLength(2);
                },
                { timeout: 10_000 },
            );
            expect(new Set(relay.machines.values()).size).toBe(2);
            const taskSession = (account: string, taskId: string) => {
                const ids = relay.taskSessions(account, taskId);
                expect(ids).toHaveLength(1);
                return ids[0]!;
            };
            await vi.waitFor(
                () => {
                    taskSession("alice-mobile", task.id);
                    taskSession("bob-mobile", bobTask.id);
                },
                { timeout: 10_000 },
            );
            expect(relay.taskSessions("bob-mobile", task.id)).toEqual([]);
            expect(relay.taskSessions("alice-mobile", bobTask.id)).toEqual([]);
            const aliceTaskSession = taskSession("alice-mobile", task.id);
            const aliceMembership = (await alice.getTask(task.id)).membership!;
            expect(relay.sessionMetadata("alice-mobile", aliceTaskSession)).toMatchObject({
                task: {
                    id: task.id,
                    name: task.name,
                    folderName: task.folderName,
                    orderKey: aliceMembership.orderKey,
                    canArchive: true,
                    owner: { userId: owners[0], name: "Alice" },
                },
                name: task.name,
            });
            expect(relay.sessionMetadata("alice-mobile", aliceTaskSession)).not.toHaveProperty(
                "project",
            );
            const joined = await bob.joinTask(task.id);
            await vi.waitFor(
                () => {
                    const sid = taskSession("bob-mobile", task.id);
                    expect(relay.sessionMetadata("bob-mobile", sid)).toMatchObject({
                        task: { canArchive: false, orderKey: joined.membership!.orderKey },
                    });
                    expect(relay.rpcMethods("bob-mobile")).toContain(`${sid}:leaveTask`);
                },
                { timeout: 10_000 },
            );
            const bobTaskSession = taskSession("bob-mobile", task.id);
            const aliceProfile = (await alice.getProfile()).profile;
            await alice.updateProfile({ name: "Alice Updated" }, { ifMatch: aliceProfile.version });
            await vi.waitFor(
                () =>
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession)).toMatchObject({
                        task: { owner: { userId: owners[0], name: "Alice Updated" } },
                    }),
                { timeout: 5_000 },
            );
            expect(await relay.callRpc("bob-mobile", `${bobTaskSession}:killSession`, {})).toEqual({
                error: "Only the task's owner or the team owner can archive this task.",
            });
            expect((await alice.getTask(task.id)).task.status).toBe("active");
            const renamed = (
                await alice.renameTask(task.id, { name: "Renamed task" }, { ifMatch: task.version })
            ).task;
            const reordered = await bob.reorderTask(task.id, { afterId: bobTask.id });
            await vi.waitFor(
                () => {
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession)).toMatchObject({
                        task: { name: renamed.name, orderKey: reordered.membership!.orderKey },
                    });
                    expect(relay.sessionMetadata("alice-mobile", aliceTaskSession)).toMatchObject({
                        task: { name: renamed.name, orderKey: aliceMembership.orderKey },
                    });
                },
                { timeout: 5_000 },
            );
            const taskMode = {
                providerId: "gym",
                modelId: "gym/model",
                effort: "medium",
                serviceTier: null,
                permissionMode: "auto" as const,
            };
            await alice.sendMessage(task.agent.id, { text: "Before leaving task", mode: taskMode });
            await vi.waitFor(
                () =>
                    expect(JSON.stringify(relay.outgoing.get(bobTaskSession))).toContain(
                        "Before leaving task",
                    ),
                { timeout: 5_000 },
            );
            expect(await relay.callRpc("bob-mobile", `${bobTaskSession}:leaveTask`, {})).toEqual({
                success: true,
            });
            await vi.waitFor(
                () => {
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession).lifecycleState).toBe(
                        "archived",
                    );
                    expect(relay.machineRooms("bob-mobile")).not.toContain(bobTaskSession);
                },
                { timeout: 5_000 },
            );
            expect((await bob.getTask(task.id)).membership).toBeNull();
            expect((await alice.getTask(task.id)).task.status).toBe("active");
            expect(relay.machineRooms("alice-mobile")).toContain(aliceTaskSession);
            const formerMemberOutput = JSON.stringify(relay.outgoing.get(bobTaskSession) ?? []);
            await alice.sendMessage(task.agent.id, {
                text: "Only current task members receive this message.",
                mode: {
                    providerId: "gym",
                    modelId: "gym/model",
                    effort: "medium",
                    serviceTier: null,
                    permissionMode: "auto",
                },
            });
            await vi.waitFor(
                () =>
                    expect(JSON.stringify(relay.outgoing.get(aliceTaskSession))).toContain(
                        "Only current task members",
                    ),
                { timeout: 5_000 },
            );
            expect(JSON.stringify(relay.outgoing.get(bobTaskSession) ?? [])).toBe(
                formerMemberOutput,
            );
            // Rejoining restores the same relay identity, not a second conversation.
            await bob.joinTask(task.id);
            await vi.waitFor(
                () =>
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession).lifecycleState).toBe(
                        "active",
                    ),
                { timeout: 5_000 },
            );
            expect(taskSession("bob-mobile", task.id)).toBe(bobTaskSession);
            await alice.sendMessage(task.agent.id, {
                text: "After rejoining task",
                mode: taskMode,
            });
            await vi.waitFor(
                () =>
                    expect(JSON.stringify(relay.outgoing.get(bobTaskSession))).toContain(
                        "After rejoining task",
                    ),
                { timeout: 5_000 },
            );
            const rejoinedOutput = relay.outgoing.get(bobTaskSession) ?? [];
            expect(
                rejoinedOutput.filter((message) =>
                    JSON.stringify(message).includes("Before leaving task"),
                ),
            ).toHaveLength(1);
            // V1 resumes live messages without replaying the absence or duplicating old history.
            expect(JSON.stringify(rejoinedOutput)).not.toContain("Only current task members");
            expect(
                await relay.callRpc("alice-mobile", `${aliceTaskSession}:killSession`, {}),
            ).toEqual({ success: true });
            await vi.waitFor(
                () => {
                    expect(
                        relay.sessionMetadata("alice-mobile", aliceTaskSession).lifecycleState,
                    ).toBe("archived");
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession).lifecycleState).toBe(
                        "archived",
                    );
                },
                { timeout: 5_000 },
            );
            const archivedTask = (await alice.getTask(task.id)).task;
            expect(archivedTask.status).toBe("archived");
            await alice.unarchiveTask(task.id, { ifMatch: archivedTask.version });
            await vi.waitFor(
                () => {
                    expect(
                        relay.sessionMetadata("alice-mobile", aliceTaskSession).lifecycleState,
                    ).toBe("active");
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession).lifecycleState).toBe(
                        "active",
                    );
                },
                { timeout: 5_000 },
            );
            await bob.leaveTask(task.id);
            // The API and relay expose precisely the same caller-relative archival matrix.
            const orphan = await runtime!.modules.tasks.create(
                withAgentDatabase(runtime!.ctx.named("test.ownerless-task"), runtime!.database),
                { name: "Ownerless task" },
            );
            await alice.joinTask(orphan.id);
            await bob.joinTask(orphan.id);
            await alice.joinTask(bobTask.id);
            for (const [client, account] of [
                [alice, "alice-mobile"],
                [bob, "bob-mobile"],
            ] as const) {
                for (const id of [orphan.id, bobTask.id]) {
                    const current = await client.getTask(id);
                    await vi.waitFor(
                        () =>
                            expect(
                                relay.sessionMetadata(account, taskSession(account, id)),
                            ).toMatchObject({
                                task: { canArchive: current.task.canArchive },
                            }),
                        { timeout: 5_000 },
                    );
                }
            }
            expect((await alice.getTask(orphan.id)).task.canArchive).toBe(true);
            expect((await bob.getTask(orphan.id)).task.canArchive).toBe(false);
            const orphanSession = taskSession("alice-mobile", orphan.id);
            await vi.waitFor(() =>
                expect(relay.rpcMethods("alice-mobile")).toContain(`${orphanSession}:killSession`),
            );
            expect(await relay.callRpc("alice-mobile", `${orphanSession}:killSession`, {})).toEqual(
                { success: true },
            );
            expect((await alice.getTask(orphan.id)).task.status).toBe("archived");
            const bobMachine = relay.machines.get("bob-mobile")!;
            const colliding = (
                await alice.createTask({
                    id: createHappySpawnSessionId(bobMachine, "collision:task"),
                    workspaceId: createHappySpawnSessionId(bobMachine, "collision:workspace"),
                    agentId: createHappySpawnSessionId(bobMachine, "collision"),
                    name: "Alice owns this identity",
                })
            ).task;
            const spawnMethod = `${bobMachine}:spawn-happy-session`;
            expect(
                await relay.callRpc("bob-mobile", spawnMethod, {
                    type: "happy-agent-spawn",
                    clientRequestId: "collision",
                    target: { kind: "task" },
                }),
            ).toEqual({ type: "error", errorMessage: "That task belongs to another owner." });
            expect(relay.taskSessions("bob-mobile", colliding.id)).toEqual([]);
            expect((await alice.getTask(colliding.id)).task.ownerUserId).toBe(owners[0]);
            relay.deliver("alice-mobile", bot.id, "Alice speaks from her phone.");
            relay.deliver("bob-mobile", bot.id, "Bob speaks from his phone.");
            await vi.waitFor(
                async () => {
                    const history = await alice.getMessages(bot.agent.id);
                    const messages = history.runs.flatMap((run) => run.messages);
                    for (const [index, text] of [
                        "Alice speaks from her phone.",
                        "Bob speaks from his phone.",
                    ].entries()) {
                        const message = messages.find((message) =>
                            JSON.stringify(message.content).includes(text),
                        );
                        expect(message?.metadata.userId).toBe(owners[index]);
                    }
                },
                { timeout: 10_000 },
            );
            // Composer drafts are private per member: each phone mirrors only its owner's.
            // A session starts at most one full pass a second, so a draft can take that long to
            // cross in either direction.
            const paced = { timeout: 5_000 };
            const draft = (text: string) => ({
                text,
                providerId: "gym",
                modelId: "gym/model",
                effort: "medium",
                serviceTier: null,
                permissionMode: "full_access" as const,
            });
            const agentId = bot.agent.id;
            const cursor = (await bob.getEvents()).latestCursor;
            expect((await bob.getAgentDraft(agentId)).draft).toEqual({
                value: null,
                updatedAt: null,
            });
            await alice.saveAgentDraft(agentId, { draft: draft("Alice desktop"), updatedAt: 200 });
            await vi.waitFor(
                () =>
                    expect(relay.metadata("alice-mobile", bot.id)).toMatchObject({
                        draft: draft("Alice desktop"),
                        draftUpdatedAt: 200,
                    }),
                paced,
            );
            expect(relay.metadata("bob-mobile", bot.id).draftUpdatedAt).toBeNull();
            expect((await bob.getAgentDraft(agentId)).draft).toEqual({
                value: null,
                updatedAt: null,
            });
            relay.updateMetadata("bob-mobile", bot.id, {
                draft: draft("Bob phone"),
                draftUpdatedAt: 300,
            });
            await vi.waitFor(
                async () =>
                    expect((await bob.getAgentDraft(agentId)).draft).toEqual({
                        value: draft("Bob phone"),
                        updatedAt: 300,
                    }),
                paced,
            );
            expect((await alice.getAgentDraft(agentId)).draft).toEqual({
                value: draft("Alice desktop"),
                updatedAt: 200,
            });
            expect(relay.metadata("alice-mobile", bot.id).draftUpdatedAt).toBe(200);
            // A stale phone write is corrected back over the relay; a newer clear is adopted.
            relay.updateMetadata("bob-mobile", bot.id, {
                draft: draft("Bob stale"),
                draftUpdatedAt: 250,
            });
            await vi.waitFor(
                () =>
                    expect(relay.metadata("bob-mobile", bot.id)).toMatchObject({
                        draft: draft("Bob phone"),
                        draftUpdatedAt: 300,
                    }),
                paced,
            );
            relay.updateMetadata("alice-mobile", bot.id, { draft: null, draftUpdatedAt: 400 });
            await vi.waitFor(
                async () =>
                    expect((await alice.getAgentDraft(agentId)).draft).toEqual({
                        value: null,
                        updatedAt: 400,
                    }),
                paced,
            );
            expect((await bob.getAgentDraft(agentId)).draft).toEqual({
                value: draft("Bob phone"),
                updatedAt: 300,
            });
            const bobEvents = JSON.stringify((await bob.getEvents({ after: cursor })).events);
            expect(bobEvents).toContain("Bob phone");
            expect(bobEvents).not.toContain("Alice desktop");
            const identities = new Map(relay.machines);
            await bob.joinTask(task.id);
            await vi.waitFor(
                () =>
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession).lifecycleState).toBe(
                        "active",
                    ),
                { timeout: 5_000 },
            );
            await runtime!.modules.happy.stop();
            await bob.leaveTask(task.id);
            const beforeOfflineRename = (await alice.getTask(task.id)).task;
            await alice.renameTask(
                task.id,
                { name: "Changed after Bob left offline" },
                { ifMatch: beforeOfflineRename.version },
            );
            await runtime!.close();
            runtime = undefined;
            // Remove Bob's membership while that connection is offline, leaving an active
            // remote projection for cold startup reaping to retire without fresh task reads.
            ({ alice, bob } = await start());
            await vi.waitFor(
                async () => {
                    expect((await alice.getHappyIntegration()).integration.status).toBe(
                        "connected",
                    );
                    expect((await bob.getHappyIntegration()).integration.status).toBe("connected");
                    expect(relay.activeMachines()).toEqual(["alice-mobile", "bob-mobile"]);
                },
                { timeout: 10_000 },
            );
            expect(relay.machines).toEqual(identities);
            await vi.waitFor(
                () => {
                    expect(relay.machineRooms("alice-mobile")).toContain(aliceTaskSession);
                    expect(relay.machineRooms("bob-mobile")).not.toContain(bobTaskSession);
                    expect(relay.sessionMetadata("bob-mobile", bobTaskSession)).toMatchObject({
                        lifecycleState: "archived",
                        task: { name: "Renamed task" },
                    });
                },
                { timeout: 5_000 },
            );
            expect(taskSession("alice-mobile", task.id)).toBe(aliceTaskSession);
            expect(
                [...relay.sessions.values()].filter((session) => session.botId === bot.id),
            ).toHaveLength(2);
            expect((await alice.getAgentDraft(agentId)).draft).toEqual({
                value: null,
                updatedAt: 400,
            });
            expect((await bob.getAgentDraft(agentId)).draft).toEqual({
                value: draft("Bob phone"),
                updatedAt: 300,
            });
            relay.rejected.add("alice-mobile");
            await runtime!.close();
            runtime = undefined;
            ({ alice, bob } = await start());
            await vi.waitFor(
                async () => {
                    expect((await alice.getHappyIntegration()).integration).toMatchObject({
                        status: "failed",
                        configured: false,
                        error: { code: "credentials_rejected" },
                    });
                    expect((await bob.getHappyIntegration()).integration.status).toBe("connected");
                    expect(relay.activeMachines()).toEqual(["bob-mobile"]);
                },
                { timeout: 10_000 },
            );
            const bobBefore = (await bob.getHappyIntegration()).integration;
            await alice.disconnectHappyIntegration();
            expect((await bob.getHappyIntegration()).integration).toEqual(bobBefore);
            await vi.waitFor(() => expect(relay.activeMachines()).toEqual(["bob-mobile"]));
            relay.deliver("bob-mobile", bot.id, "Bob is still connected.");
            await vi.waitFor(
                async () =>
                    expect(JSON.stringify(await bob.getMessages(bot.agent.id))).toContain(
                        "Bob is still connected.",
                    ),
                { timeout: 10_000 },
            );
            // Pairing Alice's daemon to another phone account must not reuse the machine id the
            // first account owns; Happy refuses it, so a fresh one is registered instead.
            const repairing = await alice.startHappyIntegration();
            relay.authorize(repairing.integration.authorization!.data, "alice-second");
            await vi.waitFor(
                async () => {
                    expect((await alice.getHappyIntegration()).integration.status).toBe(
                        "connected",
                    );
                    expect(relay.activeMachines()).toEqual(["alice-second", "bob-mobile"]);
                },
                { timeout: 10_000 },
            );
            expect(relay.machines.get("alice-second")).not.toBe(relay.machines.get("alice-mobile"));
            expect(await readFile(join(happyHome, "access.key"), "utf8")).toBe(external);
        } finally {
            await runtime?.close();
            for (const server of servers) {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
            await relay.close();
            vi.unstubAllGlobals();
            await rm(root, { recursive: true, force: true });
        }
    }, 60_000);
});
