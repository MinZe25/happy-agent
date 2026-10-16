import type { Message } from "@slopus/happy-agent-client";
import {
    CodexProvider,
    type BaseProvider,
    type BaseSession,
    type SessionEvent,
    type SessionStream,
} from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { reviewerAgentId } from "../../sources/auto/index.js";
import { ScriptedSession } from "../support/ScriptedProvider.js";
import {
    credentialWriterRuntime,
    writerMode,
    writerText,
} from "../support/credentialWriterRuntime.js";

const configuration = `[providers]
default_enable = false
[providers.private_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-first-secret"
base_url = "http://127.0.0.1:1/first"
[providers.other_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-other-secret"
base_url = "http://127.0.0.1:1/other"
`;
const terminal = (label: string): SessionEvent => ({
    type: "done",
    state: "error",
    kind: "unknown",
    message: label,
    providerError: { type: "authentication", diagnostics: { status: 401 } },
});

it("settles a real failed inference only after consuming its observation, then releases all entries", async () => {
    const probe = await observeStores();
    installSessions(async function* () {
        yield terminal("Foreground failed.");
    });
    const fixture = await credentialWriterRuntime("owner", {
        providerConfiguration: configuration,
    });
    try {
        await fixture.owner.sendMessage(fixture.agent.id, { text: "Fail once.", mode: writerMode });
        const error = await failure(fixture, fixture.agent.id, "Foreground failed.");
        expectSource(error, "private_account");
        probe.expectEnded(fixture.agent.id);
    } finally {
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 30_000);

it("concurrent agents retain only their own actually selected credential source", async () => {
    const gate = deferred();
    let entered = 0;
    const probe = await observeStores();
    installSessions(async function* (id, providerId) {
        if (id.startsWith("naming:")) {
            yield {
                type: "done",
                state: "normal",
                tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
            return;
        }
        entered += 1;
        await gate.promise;
        yield terminal(`${providerId} failed concurrently.`);
    });
    const fixture = await credentialWriterRuntime("owner", {
        providerConfiguration: configuration,
    });
    try {
        const { agent: second } = await fixture.owner.createAgent({
            workspaceId: fixture.project.id,
            title: "Second concurrent agent",
        });
        await Promise.all([
            fixture.owner.sendMessage(fixture.agent.id, { text: "First.", mode: writerMode }),
            fixture.owner.sendMessage(second.id, {
                text: "Second.",
                mode: { ...writerMode, providerId: "other_account" },
            }),
        ]);
        await vi.waitFor(() => expect(entered).toBe(2));
        gate.resolve();
        expectSource(
            await failure(fixture, fixture.agent.id, "private_account failed concurrently."),
            "private_account",
        );
        expectSource(
            await failure(fixture, second.id, "other_account failed concurrently."),
            "other_account",
        );
        probe.expectEnded(fixture.agent.id);
        probe.expectEnded(second.id);
    } finally {
        gate.resolve();
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 30_000);

it.each(["naming", "reviewer", "compaction"] as const)(
    "a concurrent %s session contributes zero attempts to the foreground observation",
    async (background) => {
        const gate = deferred();
        let foregroundId = "";
        let entered = false;
        const probe = await observeStores();
        const openedProviders = installSessions(async function* (id) {
            if (id === foregroundId) {
                entered = true;
                await gate.promise;
                yield terminal("Foreground after background.");
            } else yield terminal("Background diagnostic.");
        });
        const fixture = await credentialWriterRuntime("owner", {
            providerConfiguration: configuration,
        });
        let session: BaseSession | undefined;
        try {
            foregroundId = fixture.agent.id;
            await fixture.owner.sendMessage(foregroundId, {
                text: "Keep foreground open.",
                mode: writerMode,
            });
            await vi.waitFor(() => expect(entered).toBe(true));
            const provider = openedProviders.get(foregroundId);
            expect(provider).toBeInstanceOf(CodexProvider);
            const id =
                background === "naming"
                    ? `naming:${foregroundId}`
                    : background === "reviewer"
                      ? reviewerAgentId(foregroundId)
                      : foregroundId;
            if (background !== "compaction") expect(id).not.toBe(foregroundId);
            session = await provider!.session(id, {
                instructions: "Background fixture.",
            });
            if (background === "compaction")
                await session.compact(createRootContext(), {
                    context: { instructions: "Background fixture.", messages: [] },
                });
            else
                for await (const _event of session.run(createRootContext(), {
                    context: { instructions: "Background fixture.", messages: [] },
                })) {
                    /* drain */
                }
            // This is the actual Config-owned observation created by the real History hook.
            // No test inserts provenance or begins an observation on behalf of the writer.
            const foreground = probe.current(foregroundId);
            expect.soft(foreground).toBeDefined();
            expect.soft(foreground).toEqual([]);
            // Positive control: this exact native provider/session crossed the real capture seam,
            // but its different identity or operation kind could not claim the foreground entry.
            expect
                .soft(probe.claims(id, background === "compaction" ? "compaction" : "inference"))
                .toEqual([
                    {
                        agentId: id,
                        kind: background === "compaction" ? "compaction" : "inference",
                        handle: undefined,
                    },
                ]);
            gate.resolve();
            expectSource(
                await failure(fixture, foregroundId, "Foreground after background."),
                "private_account",
            );
            const page = await fixture.owner.getMessages(foregroundId);
            const configurations = page.runs
                .flatMap((run) => run.messages)
                .flatMap((message) =>
                    message.content.filter((block) => block.type === "configuration"),
                );
            expect
                .soft(configurations.map((block) => block.after.providerId))
                .toEqual(["private_account"]);
            probe.expectEnded(foregroundId);
        } finally {
            gate.resolve();
            await session?.destroy();
            await fixture.close();
            vi.restoreAllMocks();
        }
    },
    30_000,
);

it("abort releases the old observation and a late provider error cannot enter the next real inference", async () => {
    const probe = await observeStores();
    const nextGate = deferred();
    let late!: (value: IteratorResult<SessionEvent>) => void;
    let firstEntered = false;
    let secondEntered = false;
    installSessions((id, providerId) => {
        if (id.startsWith("naming:"))
            return (async function* () {
                yield {
                    type: "done",
                    state: "normal",
                    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                } as SessionEvent;
            })();
        if (providerId === "other_account")
            return (async function* () {
                secondEntered = true;
                await nextGate.promise;
                yield terminal("New inference failed.");
            })();
        return {
            [Symbol.asyncIterator]() {
                let started = false;
                return {
                    async next(): Promise<IteratorResult<SessionEvent>> {
                        if (!started) {
                            started = true;
                            firstEntered = true;
                            return { done: false, value: { type: "block_start" } };
                        }
                        return await new Promise((resolve) => {
                            late = resolve;
                        });
                    },
                    async return(): Promise<IteratorResult<SessionEvent>> {
                        return { done: true, value: undefined };
                    },
                };
            },
        };
    });
    const fixture = await credentialWriterRuntime("owner", {
        providerConfiguration: configuration,
    });
    try {
        await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Abort the old request.",
            mode: writerMode,
        });
        await vi.waitFor(() => expect(firstEntered && late !== undefined).toBe(true));
        await fixture.owner.abortAgent(fixture.agent.id);
        await vi.waitFor(async () =>
            expect(
                (await fixture.owner.getMessages(fixture.agent.id)).runs.some(
                    (run) => run.status === "aborted",
                ),
            ).toBe(true),
        );
        probe.expectEnded(fixture.agent.id);
        await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Run the other account.",
            mode: { ...writerMode, providerId: "other_account" },
        });
        await vi.waitFor(() => expect(secondEntered).toBe(true));
        late({ done: false, value: terminal("Late obsolete provider error.") });
        await Promise.resolve();
        await Promise.resolve();
        const current = probe.current(fixture.agent.id);
        expect.soft(current).toBeDefined();
        expect
            .soft(current?.filter((attempt) => attempt.mode.providerId === "private_account"))
            .toEqual([]);
        nextGate.resolve();
        expectSource(
            await failure(fixture, fixture.agent.id, "New inference failed."),
            "other_account",
        );
        const page = await fixture.owner.getMessages(fixture.agent.id);
        expect(JSON.stringify(page)).not.toContain("Late obsolete provider error.");
        probe.expectEnded(fixture.agent.id);
    } finally {
        nextGate.resolve();
        late?.({ done: true, value: undefined });
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 30_000);

it("the terminal real smart-route attempt supplies the failure source rather than the first account", async () => {
    const attempted: string[] = [];
    const probe = await observeStores();
    installSessions(async function* (id, providerId) {
        if (id.startsWith("naming:")) {
            yield {
                type: "done",
                state: "normal",
                tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
            return;
        }
        attempted.push(providerId);
        yield terminal("Terminal routed failure.");
    });
    const fixture = await credentialWriterRuntime("owner", {
        providerConfiguration: `${configuration}\n[providers.router]\ntype = "smart"\nenabled = true\nproviders = ["private_account", "other_account"]\n`,
    });
    try {
        const submitted = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Try both selected credentials.",
            mode: { ...writerMode, providerId: "router" },
        });
        const error = await failure(fixture, fixture.agent.id, "Terminal routed failure.");
        expect(new Set(attempted)).toEqual(new Set(["private_account", "other_account"]));
        expect(attempted).toHaveLength(2);
        expectSource(error, attempted.at(-1)!);
        const page = await fixture.owner.getMessages(fixture.agent.id);
        const configurations = page.runs
            .flatMap((run) => run.messages)
            .flatMap((message) =>
                message.content.filter((block) => block.type === "configuration"),
            );
        // API.md:4314-4320,4624-4629: snapshots record the actual concrete fallback attempts.
        expect.soft(configurations.map((block) => block.after.providerId)).toEqual(attempted);
        // API.md:4610-4614: the first baseline anchors the committed, visible affected user message.
        expect.soft(configurations[0]?.beforeMessageId).toBe(submitted.message.id);
        // API.md:4615-4616: an unanchored mid-run account switch retains its chronological position.
        expect.soft(configurations[1]?.beforeMessageId).toBeNull();
        // API.md:4610-4611,4624-4625: compare each complete execution snapshot with the previous one.
        expect.soft(configurations[1]?.before).toEqual(configurations[0]?.after);
        // API.md:4317-4320: concrete execution snapshots never overwrite the requested alias.
        expect(await fixture.owner.getAgentMode(fixture.agent.id)).toMatchObject({
            mode: { providerId: "router" },
        });
        probe.expectEnded(fixture.agent.id);
    } finally {
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 30_000);

function installSessions(run: (id: string, providerId: string) => SessionStream) {
    const openedProviders = new Map<string, CodexProvider>();
    const prototype: BaseProvider = CodexProvider.prototype;
    vi.spyOn(prototype, "session").mockImplementation(
        async function (this: CodexProvider, id, options) {
            openedProviders.set(id, this);
            const providerId = this.endpoint.endsWith("/other")
                ? "other_account"
                : "private_account";
            const session = new ScriptedSession(id, [], options);
            vi.spyOn(session, "run").mockImplementation(() => run(id, providerId));
            vi.spyOn(session, "compact").mockResolvedValue({
                status: "failed",
                kind: "inference_error",
                message: "Background compaction failed.",
            });
            return session;
        },
    );
    return openedProviders;
}

it("restart recovery and the accepted user's sequential inference each own only their one actual attempt", async () => {
    const probe = await observeStores();
    const fixture = await credentialWriterRuntime("owner");
    try {
        const send = async () => {
            const before = (await fixture.owner.getEvents()).latestCursor;
            const submitted = await fixture.owner.sendMessage(fixture.agent.id, {
                text: "Exercise sequential observations.",
                mode: writerMode,
            });
            await vi.waitFor(
                async () => {
                    const page = await fixture.owner.getMessages(fixture.agent.id);
                    const run = page.runs.find((candidate) =>
                        candidate.messages.some((row) => row.id === submitted.message.id),
                    );
                    expect(run?.status).toBe("failed");
                    expect(
                        (await fixture.owner.getEvents({ after: before })).events.some(
                            (event) =>
                                event.type === "run.finished" && event.payload.run.id === run!.id,
                        ),
                    ).toBe(true);
                },
                { timeout: 10_000, interval: 10 },
            );
            await vi.waitFor(async () =>
                expect((await fixture.owner.getAgent(fixture.agent.id)).agent.status).toBe("idle"),
            );
        };
        await send();
        probe.expectEnded(fixture.agent.id);
        await fixture.restart();
        const earlier = probe.completed(fixture.agent.id).length;
        let actualInferences = 0;
        const stop = fixture.runtime.modules.events.subscribe((event) => {
            if (event.agentId === fixture.agent.id && event.type === "inference.completed")
                actualInferences += 1;
        });
        try {
            await send();
        } finally {
            stop();
        }
        // Base follow-up #9 adds one unsolicited inference today. Whether it is present or fixed,
        // History must own one observation for EVERY actual inference, never borrow the next one's.
        expect(actualInferences).toBeGreaterThan(0);
        const observations = probe.completed(fixture.agent.id).slice(earlier);
        expect.soft(observations).toHaveLength(actualInferences);
        expect
            .soft(new Set(observations.map((entry) => entry.operationId)).size)
            .toBe(actualInferences);
        for (const observation of observations) {
            expect.soft(observation.attempts).toHaveLength(1);
            expect.soft(observation.attempts[0]?.mode.providerId).toBe("private_account");
        }
        const page = await fixture.owner.getMessages(fixture.agent.id);
        for (const row of page.runs
            .flatMap((run) => run.messages)
            .filter(
                (row) =>
                    row.role === "service" &&
                    row.content.some(
                        (block) => block.type === "text" && block.text.includes(writerText),
                    ),
            ))
            expectSource(row, "private_account");
        probe.expectEnded(fixture.agent.id);
    } finally {
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 30_000);

async function failure(
    fixture: Awaited<ReturnType<typeof credentialWriterRuntime>>,
    agentId: string,
    text: string,
) {
    let message: Message | undefined;
    await vi.waitFor(
        async () => {
            const page = await fixture.owner.getMessages(agentId);
            message = page.runs
                .filter((run) => run.status === "failed")
                .flatMap((run) => run.messages)
                .find(
                    (row) =>
                        row.role === "service" &&
                        row.content.some(
                            (block) => block.type === "text" && block.text.includes(text),
                        ),
                );
            expect(message).toBeDefined();
        },
        { timeout: 10_000, interval: 10 },
    );
    return message!;
}

function expectSource(message: Message, providerId: string) {
    expect.soft(message).toMatchObject({
        error: {
            code: "authentication_failed",
            mode: { providerId, providerType: "codex" },
            credentialSource: {
                kind: "configuration",
                location: `providers.${providerId}.api_key`,
            },
        },
    });
}

async function observeStores() {
    type ObservedStore = {
        readonly size: number;
        read(
            agentId: string,
            operationId: string,
        ): readonly { mode: { providerId: string } }[] | undefined;
    };
    const stores = new Set<ObservedStore>();
    const starts: Array<{ store: ObservedStore; agentId: string; operationId: string }> = [];
    const claims: Array<{ agentId: string; kind: string; handle: object | undefined }> = [];
    const completions: Array<{
        agentId: string;
        operationId: string;
        attempts: readonly { mode: { providerId: string } }[];
    }> = [];
    const specifier = "../../sources/config/impl/ProviderExecutionObservations.js";
    const module = await import(specifier).catch(() => undefined);
    if (module?.ProviderExecutionObservations !== undefined) {
        const prototype = module.ProviderExecutionObservations.prototype;
        const begin = prototype.begin;
        vi.spyOn(prototype, "begin").mockImplementation(function (
            this: ObservedStore,
            ...args: unknown[]
        ) {
            stores.add(this);
            starts.push({
                store: this,
                agentId: args[0] as string,
                operationId: args[1] as string,
            });
            return begin.apply(this, args);
        });
        const end = prototype.end;
        vi.spyOn(prototype, "end").mockImplementation(function (
            this: ObservedStore,
            ...args: unknown[]
        ) {
            const agentId = args[0] as string;
            const operationId = args[1] as string;
            const attempts = this.read(agentId, operationId);
            if (attempts !== undefined) completions.push({ agentId, operationId, attempts });
            return end.apply(this, args);
        });
        const claim = prototype.claim;
        vi.spyOn(prototype, "claim").mockImplementation(function (
            this: ObservedStore,
            ...args: unknown[]
        ) {
            const handle = claim.apply(this, args);
            claims.push({ agentId: args[0] as string, kind: args[1] as string, handle });
            return handle;
        });
    }
    return {
        claims(agentId: string, kind: string) {
            return claims.filter((entry) => entry.agentId === agentId && entry.kind === kind);
        },
        completed(agentId: string) {
            return completions.filter((entry) => entry.agentId === agentId);
        },
        current(agentId: string) {
            const latest = starts.findLast((start) => start.agentId === agentId);
            return latest?.store.read(agentId, latest.operationId);
        },
        expectEnded(agentId: string) {
            expect.soft(stores.size).toBeGreaterThan(0);
            for (const store of stores) expect.soft(store.size).toBe(0);
            for (const start of starts.filter((entry) => entry.agentId === agentId))
                expect.soft(start.store.read(agentId, start.operationId)).toBeUndefined();
        },
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
