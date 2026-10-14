import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import { HappyAgentClient, type EventPageResponse } from "@slopus/happy-agent-client";
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

const settingEvents = (events: EventPageResponse["events"]) =>
    events.filter((event) => event.type === "user_settings.updated").map((event) => event.payload);

it("keeps each member's settings, events, bootstrap, and restart their own", async () => {
    root = await mkdtemp(join(tmpdir(), "team-user-settings-"));
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
            'workos_organization_id = "org_settings"',
            'owner_workos_user_id = "user_alice"',
        ].join("\n"),
    );
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "settings", use: "sig" };
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
        String(input).includes("api.workos.com/sso/jwks/")
            ? Promise.resolve(Response.json({ keys: [jwk] }))
            : nativeFetch(input, init),
    );
    const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
    const token = (subject: string) =>
        new SignJWT({ client_id: clientId, org_id: "org_settings", sid: "session_settings" })
            .setProtectedHeader({ alg: "RS256", kid: "settings" })
            .setIssuer(`https://api.workos.com/user_management/${clientId}`)
            .setSubject(subject)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
    const [aliceToken, bobToken, carolToken] = await Promise.all([
        token("user_alice"),
        token("user_bob"),
        token("user_carol"),
    ]);
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
            aliceDevice: new HappyAgentClient({ endpoint, token: aliceToken }),
            bob: new HappyAgentClient({ endpoint, token: bobToken }),
            carol: new HappyAgentClient({ endpoint, token: carolToken }),
        };
    };
    let { alice, aliceDevice, bob, carol } = await start();
    for (const [client, name] of [
        [alice, "Alice"],
        [bob, "Bob"],
    ] as const) {
        const { profile } = await client.getProfile();
        await client.updateProfile({ name }, { ifMatch: profile.version });
    }

    // A member who has not saved a profile has no settings yet.
    await expect(carol.getUserSettings()).rejects.toMatchObject({ status: 401 });
    await expect(carol.getUserSetting("app.sound")).rejects.toMatchObject({ status: 401 });
    await expect(carol.saveUserSetting("app.sound", { value: "always" })).rejects.toMatchObject({
        status: 401,
    });

    const { cursor, settings: initial } = await alice.getUserSettings();
    expect(initial).toEqual([]);
    const aliceSaved = await alice.saveUserSetting("app.sound", {
        value: "always",
        updatedAt: 200,
        mutationId: "alicewrite",
    });
    expect(await bob.getUserSetting("app.sound")).toEqual({
        setting: { key: "app.sound", value: null, updatedAt: null, version: null },
    });
    expect(await aliceDevice.getUserSetting("app.sound")).toEqual(aliceSaved);
    const bobSaved = await bob.saveUserSetting("app.sound", { value: "never", updatedAt: 100 });
    expect(bobSaved.setting.value).toBe("never");
    expect((await alice.getUserSettings()).settings).toEqual([aliceSaved.setting]);
    expect((await alice.getDesktopBootstrap()).userSettings).toEqual([aliceSaved.setting]);
    expect((await bob.getDesktopBootstrap()).userSettings).toEqual([bobSaved.setting]);

    const bobPage = await bob.getEvents({ after: cursor });
    expect(settingEvents(bobPage.events)).toEqual([{ setting: bobSaved.setting }]);
    expect(JSON.stringify(bobPage)).not.toContain("always");
    expect(settingEvents((await alice.getEvents({ after: cursor })).events)).toEqual([
        { setting: aliceSaved.setting, mutationId: "alicewrite" },
    ]);

    const abort = new AbortController();
    const frames = alice.streamEvents({
        after: cursor,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
    });
    const nextSetting = async () => {
        for (let count = 0; count < 100; count++) {
            const { value, done } = await frames.next();
            if (done) throw new Error("The event stream ended.");
            if (value.kind === "event" && value.event.type === "user_settings.updated")
                return value.event.payload;
        }
        throw new Error("Missing user settings event.");
    };
    try {
        expect((await frames.next()).value?.kind).toBe("hello");
        // Replayed after the cursor, skipping Bob's write between Alice's own.
        expect(await nextSetting()).toEqual({
            setting: aliceSaved.setting,
            mutationId: "alicewrite",
        });
        await bob.saveUserSetting("app.sound", { value: "focused", updatedAt: 101 });
        const cleared = await aliceDevice.saveUserSetting("app.sound", {
            value: null,
            updatedAt: 300,
        });
        expect(cleared.setting).toMatchObject({ value: null, updatedAt: 300 });
        expect(await nextSetting()).toEqual({ setting: cleared.setting });
        const afterClear = (await alice.getEvents()).latestCursor;
        expect(
            await alice.saveUserSetting("app.sound", { value: "stale", updatedAt: 299 }),
        ).toEqual(cleared);
        expect(settingEvents((await alice.getEvents({ after: afterClear })).events)).toEqual([]);
    } finally {
        abort.abort();
        await frames.return(undefined);
    }

    const beforeHidden = (await alice.getEvents()).latestCursor;
    await bob.saveUserSetting("app.sound", { value: "never", updatedAt: 102 });
    const hidden = await alice.getEvents({ after: beforeHidden, limit: 1 });
    expect(hidden.events).toEqual([]);
    expect(hidden.cursor).not.toBe(beforeHidden);

    await Promise.all([
        alice.saveUserSetting("app.sound", { value: "older", updatedAt: 400 }),
        aliceDevice.saveUserSetting("app.sound", { value: "newest", updatedAt: 500 }),
    ]);
    expect((await alice.getUserSetting("app.sound")).setting.value).toBe("newest");
    const final = await alice.saveUserSetting("app.sound", { value: null, updatedAt: 600 });

    await stop();
    ({ alice, aliceDevice, bob, carol } = await start());
    expect((await alice.getUserSettings()).settings).toEqual([final.setting]);
    expect((await bob.getUserSetting("app.sound")).setting).toMatchObject({
        value: "never",
        updatedAt: 102,
    });
    expect(
        (await aliceDevice.saveUserSetting("app.sound", { value: "old device", updatedAt: 500 }))
            .setting,
    ).toEqual(final.setting);
    const after = await alice.saveUserSetting("app.sound", { value: "after restart" });
    expect(after.setting.version! > final.setting.version!).toBe(true);
    await expect(carol.getUserSettings()).rejects.toMatchObject({ status: 401 });
}, 30_000);
