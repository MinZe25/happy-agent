import { HappyAgentClient, type MessageMode } from "@slopus/happy-agent-client";
import {
    createAgentGym,
    createUnixSocketFetch,
    type AgentGym,
    type AgentGymOptions,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

const forged = {
    account: { id: "forged-account", label: "Forged account" },
    providerType: "forged-family",
};
const skill = "---\nname: probe\ndescription: Probe request mode.\n---\n\nAnswer briefly.";

describe.each(["standalone", "team"] as const)("%s requested execution modes", (deployment) => {
    async function start(options: AgentGymOptions = {}) {
        const gym =
            deployment === "team"
                ? (await surfaceTeamClients(options)).gym
                : await createAgentGym(options);
        running.push(gym);
        return gym;
    }

    it("accepts and discards forged provenance before send, history, last mode, and restart", async () => {
        const gym = await start({ inference: [{ content: [{ type: "text", text: "Done." }] }] });
        const client = forgedClient(gym, forged);
        const mode = modeFor(gym);
        const sent = await client.sendMessage(gym.defaultSessionId, { mode, text: "Hello." });
        expect(sent.message.mode).toEqual(mode);
        await waitForCompletedRuns(gym, 1);
        await expect(gym.client.getAgentMode(gym.defaultSessionId)).resolves.toEqual({ mode });
        expectUserModes(await gym.client.getMessages(gym.defaultSessionId), mode);
        expect(JSON.stringify(await gym.client.getEvents({ limit: 1000 }))).not.toContain(
            "forged-",
        );
        await gym.restart();
        await expect(gym.client.getAgentMode(gym.defaultSessionId)).resolves.toEqual({ mode });
        expectUserModes(await gym.client.getMessages(gym.defaultSessionId), mode);
        expect(gym.errors).toEqual([]);
    }, 30_000);

    it.each(["queue", "steer"] as const)(
        "discards provenance before a %s submission becomes pending or accepted",
        async (delivery) => {
            const ready = deferred();
            const gate = deferred();
            let calls = 0;
            const gym = await start({
                inference: async (request) => {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "Mode probe" }] };
                    if (calls++ === 0) {
                        ready.resolve();
                        await gate.promise;
                    }
                    return { content: [{ type: "text", text: "Done." }] };
                },
            });
            try {
                const first = await gym.send("First.", { wait: false });
                await ready.promise;
                const mode = modeFor(gym);
                const sent = await forgedClient(gym, forged).sendMessage(gym.defaultSessionId, {
                    delivery,
                    mode,
                    text: "Next.",
                });
                expect(sent.message.mode).toEqual(mode);
                const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
                expect(bootstrap.pending).toContainEqual(sent.message);
                expect(JSON.stringify(bootstrap)).not.toContain("forged-");
                gate.resolve();
                await gym.waitUntil(async () => {
                    const history = await gym.client.getMessages(gym.defaultSessionId);
                    const interrupted = history.runs.filter((run) => run.status === "aborted");
                    const expectedInterruption =
                        delivery === "steer"
                            ? interrupted.length === 1 &&
                              interrupted[0]?.id === first.runId &&
                              interrupted[0]?.reason === "steering"
                            : interrupted.length === 0;
                    return expectedInterruption &&
                        history.runs.some(
                            (run) =>
                                run.status === "completed" &&
                                run.messages.some(
                                    (message) =>
                                        message.id === sent.message.id &&
                                        message.role === "user" &&
                                        message.status === "accepted",
                                ),
                        ) &&
                        history.runs.every(
                            (run) =>
                                run.status === "completed" ||
                                (delivery === "steer" && run.id === first.runId),
                        )
                        ? history
                        : undefined;
                }, "the queued or steered message to settle");
                expectUserModes(await gym.client.getMessages(gym.defaultSessionId), mode);
                expect(gym.errors).toEqual([]);
            } finally {
                gate.resolve();
            }
        },
        30_000,
    );

    it("discards provenance before invoking a skill", async () => {
        const gym = await start({
            files: { ".agents/skills/probe/SKILL.md": skill },
            inference: [{ content: [{ type: "text", text: "Done." }] }],
        });
        const mode = modeFor(gym);
        await forgedClient(gym, forged).invokeSlashCommand(gym.defaultSessionId, "probe", {
            mode,
        });
        await waitForCompletedRuns(gym, 1);
        expectUserModes(await gym.client.getMessages(gym.defaultSessionId), mode);
        expect(JSON.stringify(await gym.client.getEvents({ limit: 1000 }))).not.toContain(
            "forged-",
        );
        expect(gym.errors).toEqual([]);
    }, 30_000);

    it("discards provenance before saving a draft, including null account", async () => {
        const gym = await start();
        const draft = { ...modeFor(gym), text: "Draft text." };
        const at = Date.now();
        for (const [index, extra] of [forged, { ...forged, account: null }].entries()) {
            await expect(
                forgedClient(gym, extra).saveAgentDraft(gym.defaultSessionId, {
                    draft,
                    updatedAt: at + index,
                }),
            ).resolves.toEqual({ draft: { value: draft, updatedAt: at + index } });
        }
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).draft).toEqual({
            value: draft,
            updatedAt: at + 1,
        });
        await gym.restart();
        await expect(gym.client.getAgentDraft(gym.defaultSessionId)).resolves.toEqual({
            draft: { value: draft, updatedAt: at + 1 },
        });
        expect(gym.errors).toEqual([]);
    }, 30_000);

    it("rejects malformed provenance while dropping previously accepted unknown mode fields", async () => {
        const gym = await start({
            files: { ".agents/skills/probe/SKILL.md": skill },
            inference: [{ content: [{ type: "text", text: "Done." }] }],
        });
        const mode = modeFor(gym);
        for (const extra of [
            { providerType: "x".repeat(129) },
            { providerType: "" },
            { account: { id: "x".repeat(257) } },
            { account: { id: "" } },
            { account: { id: "a", label: "x".repeat(257) } },
        ]) {
            const client = forgedClient(gym, extra);
            await expect(
                client.sendMessage(gym.defaultSessionId, { mode, text: "Invalid." }),
            ).rejects.toMatchObject({ status: 400 });
            await expect(
                client.invokeSlashCommand(gym.defaultSessionId, "compact", { mode }),
            ).rejects.toMatchObject({ status: 400 });
            await expect(
                client.saveAgentDraft(gym.defaultSessionId, {
                    draft: { ...mode, text: "Invalid." },
                }),
            ).rejects.toMatchObject({ status: 400 });
        }
        expect(gym.inference.requests).toEqual([]);
        const client = forgedClient(gym, {
            unknownExecutionField: "unknown-mode-marker",
            account: { id: "a", unknownAccountField: "unknown-account-marker" },
        });
        await expect(
            client.sendMessage(gym.defaultSessionId, { mode, text: "Unknown." }),
        ).rejects.toMatchObject({ status: 400 });
        const invoked = await client.invokeSlashCommand(gym.defaultSessionId, "probe", { mode });
        expect(invoked.command.name).toBe("probe");
        expect(JSON.stringify(invoked)).not.toContain("unknown-");
        await waitForCompletedRuns(gym, 1);
        expectUserModes(await gym.client.getMessages(gym.defaultSessionId), mode);
        const draft = { ...mode, text: "Known draft." };
        const updatedAt = Date.now();
        await expect(
            client.saveAgentDraft(gym.defaultSessionId, { draft, updatedAt }),
        ).resolves.toEqual({ draft: { value: draft, updatedAt } });
        const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
        expect(bootstrap.draft.value).toEqual(draft);
        expect(JSON.stringify(bootstrap)).not.toContain("unknown-");
        expect(JSON.stringify(await gym.client.getEvents({ limit: 1000 }))).not.toContain(
            "unknown-",
        );
        await gym.restart();
        expectUserModes(await gym.client.getMessages(gym.defaultSessionId), mode);
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).draft.value).toEqual(
            draft,
        );
    }, 30_000);

    it("leaves similarly named opaque user settings unchanged", async () => {
        const gym = await start();
        const value = { mode: forged, account: forged.account, providerType: forged.providerType };
        await forgedClient(gym, forged).saveUserSetting("mode-probe", { value });
        expect((await gym.client.getUserSetting("mode-probe")).setting.value).toEqual(value);
    });
});

function modeFor(gym: AgentGym): MessageMode {
    return { ...gym.selection, permissionMode: "auto" };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((ready) => {
        resolve = ready;
    });
    return { promise, resolve };
}

/** Inject after the published SDK strips output fields, at its public Fetch boundary only. */
function forgedClient(gym: AgentGym, extra: Record<string, unknown>): HappyAgentClient {
    const transport =
        gym.daemon.httpUrl === undefined ? createUnixSocketFetch(gym.socketPath) : fetch;
    return new HappyAgentClient({
        endpoint: gym.daemon.httpUrl ?? "http://happy-agent.gym",
        token: gym.token,
        fetch: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (
                /^\/v0\/agents\/[^/]+\/(send|draft|slash-commands\/[^/]+)$/.test(path) &&
                typeof init?.body === "string"
            ) {
                const body = JSON.parse(init.body);
                const field = path.endsWith("/draft") ? "draft" : "mode";
                body[field] = { ...body[field], ...extra };
                return await transport(input, { ...init, body: JSON.stringify(body) });
            }
            return await transport(input, init);
        },
    });
}

async function waitForCompletedRuns(gym: AgentGym, count: number) {
    return await gym.waitUntil(async () => {
        const history = await gym.client.getMessages(gym.defaultSessionId);
        return history.runs.length === count &&
            history.runs.every((run) => run.status === "completed")
            ? history
            : undefined;
    }, "the requested runs to complete");
}

function expectUserModes(
    history: Awaited<ReturnType<HappyAgentClient["getMessages"]>>,
    mode: MessageMode,
) {
    const users = history.runs.flatMap((run) =>
        run.messages.filter((message) => message.role === "user"),
    );
    expect(users.length).toBeGreaterThan(0);
    for (const message of users) expect(message.mode).toEqual(mode);
}
