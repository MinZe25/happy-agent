import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import { HappyAgentClient, type HappyAgentEvent } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

let runtime: HappyAgentRuntime | undefined;
let server: Server | undefined;
let root: string | undefined;
async function stop() {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await runtime?.close();
    runtime = undefined;
}
afterEach(async () => {
    await stop();
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
});

it("attributes team HTTP creation to the authenticated local user and preserves it across other users' edits and restart", async () => {
    root = await mkdtemp(join(tmpdir(), "sa-"));
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
            'workos_organization_id = "org_surfaces"',
            'owner_workos_user_id = "user_alice"',
        ].join("\n"),
    );
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "surfaces", use: "sig" };
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
        String(input).includes("api.workos.com/sso/jwks/")
            ? Promise.resolve(Response.json({ keys: [jwk] }))
            : nativeFetch(input, init),
    );
    const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
    const token = (subject: string) =>
        new SignJWT({ client_id: clientId, org_id: "org_surfaces", sid: "session_surfaces" })
            .setProtectedHeader({ alg: "RS256", kid: "surfaces" })
            .setIssuer(`https://api.workos.com/user_management/${clientId}`)
            .setSubject(subject)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
    const [aliceToken, bobToken] = await Promise.all([token("user_alice"), token("user_bob")]);
    const start = async () => {
        let endpoint = "";
        const providers = new AgentProviders();
        providers.add("gym", new ScriptedProvider([]), "codex");
        runtime = await startHappyAgentRuntime({
            happyHome,
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
                    void prepared.api.handleRequest(
                        prepared.context("test.http"),
                        request,
                        response,
                    );
                });
                await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
                const address = server.address();
                if (!address || typeof address === "string")
                    throw new Error("Missing fixture address.");
                endpoint = `http://127.0.0.1:${address.port}`;
            },
        });
        return {
            alice: new HappyAgentClient({ endpoint, token: aliceToken }),
            bob: new HappyAgentClient({ endpoint, token: bobToken }),
        };
    };
    let { alice, bob } = await start();
    for (const [client, name] of [
        [alice, "Alice"],
        [bob, "Bob"],
    ] as const) {
        const { profile } = await client.getProfile();
        await client.updateProfile({ name }, { ifMatch: profile.version });
    }
    const aliceId = (await alice.getProfile()).profile.userId;
    const bobId = (await bob.getProfile()).profile.userId;
    expect(aliceId).toEqual(expect.any(String));
    expect(bobId).toEqual(expect.any(String));
    expect(aliceId).not.toBe("user_alice");
    expect(bobId).not.toBe("user_bob");
    const before = (await alice.getEvents()).latestCursor;
    const surface = (await alice.createSurface({ type: "todo", name: "Team" })).surface;
    expect(surface).toMatchObject({ creatorUserId: aliceId, members: [{ userId: aliceId }] });
    const todo = (await bob.createTodo(surface.id, { text: "Bob wrote this" })).todo;
    expect(todo.authorUserId).toBe(bobId);
    expect(
        (await bob.getTodoVersion(surface.id, todo.id, todo.version)).revision.actor.userId,
    ).toBe(bobId);
    const changed = (
        await alice.updateTodo(
            surface.id,
            todo.id,
            { text: "Alice edited", status: "completed" },
            { ifMatch: todo.version },
        )
    ).todo;
    expect(changed.authorUserId).toBe(bobId);
    const latest = (await bob.getTodoVersion(surface.id, todo.id, changed.version)).revision;
    expect(latest).toMatchObject({
        actor: { userId: aliceId, agentId: null },
        todo: { authorUserId: bobId },
    });
    expect((await alice.createTodo(surface.id, { id: todo.id, text: "Retry" })).todo).toEqual(
        changed,
    );
    expect(
        (await bob.createSurface({ id: surface.id, type: "todo", name: "Retry" })).surface,
    ).toEqual(surface);
    const left = (await alice.leaveSurface(surface.id)).surface;
    expect(left).toMatchObject({ creatorUserId: aliceId, members: [] });
    await expect(
        alice.createSurface({ type: "todo", name: "Spoof", creatorUserId: bobId } as never),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(
        alice.createTodo(surface.id, { text: "Spoof", authorUserId: bobId } as never),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(
        alice.updateTodo(surface.id, todo.id, { text: "Spoof", authorUserId: aliceId } as never, {
            ifMatch: changed.version,
        }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect((await alice.listSurfaces()).surfaces).toEqual([left]);
    expect((await alice.getTodo(surface.id, todo.id)).todo).toEqual(changed);

    const observed: HappyAgentEvent[] = [];
    for await (const frame of bob.streamEvents({
        after: before,
        signal: AbortSignal.timeout(10_000),
    })) {
        if (frame.kind !== "event") continue;
        observed.push(frame.event);
        if (frame.event.type === "surface.updated" && frame.event.payload.version === left.version)
            break;
    }
    expect(observed.find((event) => event.type === "surface.created")?.payload).toMatchObject({
        surface: { creatorUserId: aliceId },
    });
    expect(observed.find((event) => event.type === "todo.created")?.payload).toMatchObject({
        todo: { authorUserId: bobId },
    });
    const revisions = await bob.listTodoVersions(surface.id, todo.id);
    expect(revisions.versions.map((revision) => revision.todo.authorUserId)).toEqual([
        bobId,
        bobId,
    ]);
    await stop();
    ({ alice, bob } = await start());
    expect((await bob.getDesktopBootstrap()).surfaces).toEqual([left]);
    expect((await alice.getTodo(surface.id, todo.id)).todo).toEqual(changed);
    expect(await bob.listTodoVersions(surface.id, todo.id)).toEqual(revisions);
}, 60_000);
