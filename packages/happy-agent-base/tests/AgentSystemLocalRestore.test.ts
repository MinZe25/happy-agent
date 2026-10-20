import { Type } from "@sinclair/typebox";
import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionEvent,
    type SessionMessage,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { afterCommit, createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    AgentStorage,
    AgentSystemLocal,
    defineAgentTool,
    withAgentDatabase,
    type AgentConfig,
    type AgentModule,
    type AgentModuleHooks,
    type AgentPersistence,
    type AgentStorageLock,
} from "../sources/index.js";
import { agentStorageTransaction } from "../sources/AgentContexts.js";
import { databaseBackends, type TestDatabase } from "./gym/databaseBackends.js";
import { inMemoryStorageLock, providersOf, queued, textTurn, user } from "./gym/fixtures.js";

/*
 * A collection used to restore every identity it held as it started. It now restores at start
 * only the agents that owe work or that a module names, and every other agent the first time
 * something uses it. These tests hold the lazy start to the eager one it replaced.
 *
 * The eager start is reproduced exactly by a module naming every identity for restoration at
 * start: each is then restored before anything else happens, and only the ones owing work are
 * built, which is what the eager start did. Every scenario runs both ways on its own SQLite
 * database and must end in the same durable state, with the same answers and the same hooks
 * apart from when restoration ran.
 */

const ctx = createRootContext().named("agent-system-restore-test");
const LOOP_ID = "l12345678901234567890123";
const SUBJECT = "subject";
const BYSTANDER = "bystander";
const PARENT = "parent";

vi.setConfig({ testTimeout: 60_000 });

/** A provider answering every request from its last message, so any order of runs agrees. */
class EchoProvider extends BaseProvider {
    static override readonly name = "echo";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];
    /** Every answered request, as `<agent>:<what it answered>`. */
    readonly answers: string[] = [];
    /**
     * Agents whose first request told to hang never got an answer, as if the process died during
     * it. The same request asked again is answered.
     */
    readonly hanging = new Set<string>();

    session(id: string, _options: SessionOptions): Promise<BaseSession> {
        return Promise.resolve(new EchoSession(id, this));
    }
}

class EchoSession extends BaseSession {
    readonly #provider: EchoProvider;
    #calls = 0;

    constructor(id: string, provider: EchoProvider) {
        super(id);
        this.#provider = provider;
    }

    run(_ctx: Context, request: SessionRunRequest): SessionStream {
        const said = lastSaid(request.context.messages);
        if (said === "hang" && !this.#provider.hanging.has(this.id)) {
            this.#provider.hanging.add(this.id);
            return (async function* (): AsyncGenerator<SessionEvent> {
                await new Promise<never>(() => undefined);
            })();
        }
        this.#provider.answers.push(`${this.id}:${said}`);
        if (said === "wait") {
            this.#calls += 1;
            const callId = `wait${this.id}${String(this.#calls)}`;
            return events([
                { type: "toolcall_start", callId, name: "probe_wait" },
                { type: "toolcall_end", callId, arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ]);
        }
        return events(textTurn(`echo ${said}`));
    }

    compact(): Promise<SessionCompaction> {
        this.#provider.answers.push(`${this.id}:compact`);
        return Promise.resolve({
            status: "completed",
            preservedMessages: [],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            context: {
                instructions: "",
                messages: [{ role: "compaction", content: "summary", encryptedContent: null }],
            },
        });
    }

    destroy(): void {}
}

function events(batch: readonly SessionEvent[]): SessionStream {
    return (async function* (): AsyncGenerator<SessionEvent> {
        yield* batch;
    })();
}

function lastSaid(messages: readonly SessionMessage[]): string {
    const last = messages.at(-1);
    if (last?.role !== "user") return last?.role ?? "nothing";
    return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * Records every lifecycle step and agent hook one process runs, and every agent hook that ran
 * for an agent the process had neither restored nor created, which must never happen.
 */
class Probe implements AgentModule {
    readonly name = "probe";
    /** Lifecycle steps and agent hooks, in the order this process committed or ran them. */
    readonly log: string[] = [];
    /** Committed restorations in this process, per agent. */
    readonly restores = new Map<string, number>();
    /** Agent hooks that reached an agent before this process restored or created it. */
    readonly unrestoredUses: string[] = [];
    /** Agents whose wait tool is running. */
    readonly waiting = new Set<string>();
    readonly #created = new Set<string>();
    readonly #demand: () => readonly string[];
    readonly #holdWaits: boolean;
    readonly #extra: ((probe: Probe) => AgentModuleHooks) | undefined;

    constructor(
        options: {
            readonly demand?: () => readonly string[];
            readonly holdWaits?: boolean;
            readonly hooks?: (probe: Probe) => AgentModuleHooks;
        } = {},
    ) {
        this.#demand = options.demand ?? (() => []);
        this.#holdWaits = options.holdWaits ?? false;
        this.#extra = options.hooks;
    }

    restored(agentId: string): number {
        return this.restores.get(agentId) ?? 0;
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        ...this.#extra?.(this),
        agentsToRestoreTransact: () => this.#demand(),
        agentCreatedTransact: (hookCtx, _scope, agent) => {
            afterCommit(hookCtx, () => {
                this.#created.add(agent.id);
                this.log.push(`created:${agent.id}`);
            });
        },
        agentRestoredTransact: (hookCtx, _scope, agent) => {
            afterCommit(hookCtx, () => {
                this.restores.set(agent.id, this.restored(agent.id) + 1);
                this.log.push(`restored:${agent.id}`);
            });
        },
        agentArchivedTransact: (hookCtx, _scope, agent) => {
            afterCommit(hookCtx, () => {
                this.#created.delete(agent.id);
                this.log.push(`archived:${agent.id}`);
            });
        },
        beforeAgentLoop: (_hookCtx, scope) => {
            this.#use("loop", scope.agent.id);
        },
        instructions: (_hookCtx, scope) => {
            this.#use("inference", scope.agent.id);
            return "";
        },
        tools: (_hookCtx, scope) => [this.#waitTool(scope.agent.id)],
    });

    #use(kind: string, agentId: string): void {
        if (this.restored(agentId) === 0 && !this.#created.has(agentId)) {
            this.unrestoredUses.push(`${kind}:${agentId}`);
        }
        this.log.push(`${kind}:${agentId}`);
    }

    #waitTool(agentId: string) {
        return defineAgentTool({
            name: "probe_wait",
            returnType: Type.Object({}),
            reloadable: true,
            steerable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx) => {
                this.log.push(`wait:${agentId}`);
                if (!this.#holdWaits) return {};
                this.waiting.add(agentId);
                const lifetime = toolCtx.lifetime;
                await new Promise<void>((resolve) => {
                    if (lifetime === undefined || lifetime.aborted) resolve();
                    lifetime?.addEventListener("abort", () => resolve(), { once: true });
                });
                return {};
            },
            toLLM: () => [],
        });
    }
}

/** One durable store and the provider every process over it answers through. */
class World {
    readonly provider = new EchoProvider();
    readonly database: TestDatabase["database"];
    readonly dbCtx: Context;
    readonly #close: TestDatabase["close"];
    readonly #inspect: AgentStorage;
    #lock: (ctx: Context) => Promise<AgentStorageLock> = inMemoryStorageLock();

    private constructor(opened: TestDatabase) {
        this.database = opened.database;
        this.#close = opened.close;
        this.dbCtx = withAgentDatabase(ctx, opened.database);
        this.#inspect = new AgentStorage({
            acquireLock: inMemoryStorageLock(),
            database: opened.database,
        });
    }

    static async open(open: () => Promise<TestDatabase>): Promise<World> {
        return new World(await open());
    }

    /** Bring up one process over the store. */
    async process(
        probe: Probe,
        options: {
            readonly modules?: readonly AgentModule[];
            readonly storage?: (
                options: ConstructorParameters<typeof AgentStorage>[0],
            ) => AgentStorage;
        } = {},
    ): Promise<AgentSystemLocal> {
        const storageOptions = { acquireLock: this.#lock, database: this.database };
        return await AgentSystemLocal.create(
            ctx,
            options.storage?.(storageOptions) ?? new AgentStorage(storageOptions),
            {
                modules: [probe, ...(options.modules ?? [])],
                providers: providersOf(this.provider),
                provider: "scripted",
                models: [],
            },
        );
    }

    /** Leave the current process running and unreachable, as a process that died would be. */
    abandon(): void {
        this.#lock = inMemoryStorageLock();
    }

    async write(agentId: string, key: string, value: unknown): Promise<void> {
        await this.#inspect.persistence(agentId).writeValue(this.dbCtx, key, value);
    }

    async exists(agentId: string): Promise<boolean> {
        return (await this.#inspect.kv.scoped("config").read(this.dbCtx, agentId)) !== undefined;
    }

    /** What every named agent durably holds, without what differs from one run to the next. */
    async snapshot(agentIds: readonly string[]): Promise<Record<string, unknown>> {
        const state: Record<string, unknown> = {};
        for (const agentId of agentIds) {
            const persistence = this.#inspect.persistence(agentId);
            const values = await persistence.readValues(this.dbCtx, "");
            const value = (key: string): unknown =>
                values.find((entry) => entry.key === key)?.value;
            const owed = value("owed") as { readonly stage?: unknown } | undefined;
            state[agentId] = {
                exists: await this.exists(agentId),
                history: stable(await persistence.load(this.dbCtx)),
                owed: owed?.stage ?? null,
                queued: stable(
                    values
                        .filter(({ key }) => key.startsWith("send.") || key.startsWith("steering."))
                        .map((entry) => entry.value),
                ),
                metadata: (value("agentConfig") as AgentConfig | undefined)?.metadata ?? null,
            };
        }
        return state;
    }

    async close(): Promise<void> {
        await this.#close();
    }
}

const VOLATILE = new Set(["id", "metadata", "contextToolIds", "loopId", "turnId", "inferenceId"]);

/** A copy without the identities and times each run allocates for itself. */
function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !VOLATILE.has(key))
            .map(([key, entry]) => [key, stable(entry)]),
    );
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

async function settle(system: AgentSystemLocal, agentIds: readonly string[]): Promise<void> {
    for (const agentId of agentIds) await (await system.resolve(ctx, agentId)).waitForIdle();
}

/** What an operation came to, comparable between runs. */
async function outcome(work: () => Promise<unknown>): Promise<string> {
    try {
        await work();
        return "ok";
    } catch (error: unknown) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** One durable state a previous process can leave an agent in. */
interface LeftBehind {
    /** Whether the agent's store holds a valid pending record afterwards. */
    readonly owes: boolean;
    /** Whether a module asks for the agent to be restored at start. */
    readonly named?: boolean;
    /** Whether the subject still exists afterwards. */
    readonly exists?: boolean;
    /** Whether the subject is a subtask of `PARENT`. */
    readonly subtask?: boolean;
    /** Leave the state behind, from a first process that has already created the bystander. */
    readonly leave: (
        world: World,
        system: AgentSystemLocal,
        probe: Probe,
    ) => Promise<"abandon" | void>;
}

async function settledSubject(system: AgentSystemLocal, parent?: string): Promise<void> {
    const agent = await system.create(
        ctx,
        {},
        {
            id: SUBJECT,
            ...(parent === undefined ? {} : { parent }),
        },
    );
    await agent.send(ctx, user("hello"));
    await agent.waitForIdle();
}

const LEFT_BEHIND: Readonly<Record<string, LeftBehind>> = {
    settled: { owes: false, leave: async (_world, system) => await settledSubject(system) },
    archived: {
        owes: false,
        leave: async (_world, system) => {
            await settledSubject(system);
            await system.updateMetadata(ctx, SUBJECT, { archivedAt: 1 });
        },
    },
    subtask: {
        owes: false,
        subtask: true,
        leave: async (_world, system) => await settledSubject(system, PARENT),
    },
    "queued without pending work": {
        owes: false,
        // An abort leaves queued input queued without the pending record, so a restart does not
        // run it; neither may a lazy start, nor the first use of the agent.
        leave: async (world, system) => {
            await settledSubject(system);
            await world.write(SUBJECT, "send.0001", queued(user("left queued")));
        },
    },
    "accepted and unprocessed": {
        owes: true,
        leave: async (world, system) => {
            await settledSubject(system);
            await world.write(SUBJECT, "send.0001", queued(user("accepted before the crash")));
            await world.write(SUBJECT, "owed", { stage: "inference", loopId: LOOP_ID });
        },
    },
    "crashed mid-inference": {
        owes: true,
        leave: async (world, system) => {
            const agent = await system.create(ctx, {}, { id: SUBJECT });
            await agent.send(ctx, user("hang"));
            await until(() => world.provider.hanging.has(SUBJECT));
            return "abandon";
        },
    },
    "waiting tool call": {
        owes: true,
        leave: async (_world, system, probe) => {
            const agent = await system.create(ctx, {}, { id: SUBJECT });
            await agent.send(ctx, user("wait"));
            await until(() => probe.waiting.has(SUBJECT));
            await system.drain();
        },
    },
    "waiting tool call with a queued message": {
        owes: true,
        leave: async (_world, system, probe) => {
            const agent = await system.create(ctx, {}, { id: SUBJECT });
            await agent.send(ctx, user("wait"));
            await until(() => probe.waiting.has(SUBJECT));
            await agent.send(ctx, user("queued behind the wait"));
            await system.drain();
        },
    },
    "compaction pending": {
        owes: true,
        leave: async (world, system) => {
            await settledSubject(system);
            await world.write(SUBJECT, "owed", { stage: "compaction", loopId: LOOP_ID });
        },
    },
    "unreadable pending record": {
        owes: false,
        leave: async (world, system) => {
            await settledSubject(system);
            await world.write(SUBJECT, "owed", { stage: "not-a-stage", loopId: LOOP_ID });
        },
    },
    "named by a module": {
        owes: false,
        named: true,
        leave: async (_world, system) => await settledSubject(system),
    },
    "subtask owing work": {
        owes: true,
        subtask: true,
        leave: async (world, system) => {
            await settledSubject(system, PARENT);
            await world.write(SUBJECT, "send.0001", queued(user("owed by a subtask")));
            await world.write(SUBJECT, "owed", { stage: "inference", loopId: LOOP_ID });
        },
    },
    "deleted with pending work left in its store": {
        owes: false,
        exists: false,
        named: true,
        leave: async (world, system) => {
            await settledSubject(system);
            await system.delete(ctx, SUBJECT);
            await world.write(SUBJECT, "send.0001", queued(user("never delivered")));
            await world.write(SUBJECT, "owed", { stage: "inference", loopId: LOOP_ID });
        },
    },
};

/** One way the next process can first touch the subject. */
interface Touch {
    /** Whether this is a use, which restores the agent first, rather than a read. */
    readonly uses: boolean;
    readonly touch: (world: World, system: AgentSystemLocal) => Promise<string>;
}

const TOUCHES: Readonly<Record<string, Touch>> = {
    nothing: { uses: false, touch: () => Promise.resolve("ok") },
    "configuration and relations": {
        uses: false,
        touch: async (_world, system) =>
            [
                await outcome(() => system.config(ctx, SUBJECT)),
                await outcome(() => system.childOf(ctx, SUBJECT)),
                await outcome(() => system.parentOf(ctx, SUBJECT)),
            ].join(", "),
    },
    "creating the same identity": {
        uses: false,
        touch: async (_world, system) =>
            await outcome(() => system.create(ctx, {}, { id: SUBJECT })),
    },
    resolve: {
        uses: true,
        touch: async (_world, system) => await outcome(() => system.resolve(ctx, SUBJECT)),
    },
    send: {
        uses: true,
        touch: async (_world, system) =>
            await outcome(() => system.send(ctx, SUBJECT, user("sent after the restart"))),
    },
    "send in a transaction": {
        uses: true,
        touch: async (world, system) =>
            await outcome(() =>
                world.dbCtx.inTx(
                    async (txCtx) =>
                        await system.send(txCtx, SUBJECT, user("sent in a transaction")),
                ),
            ),
    },
    "send in a rolled-back transaction, then resolve": {
        uses: true,
        touch: async (world, system) =>
            [
                await outcome(() =>
                    world.dbCtx.inTx(async (txCtx) => {
                        await system.send(txCtx, SUBJECT, user("rolled back"));
                        throw new Error("rolled back");
                    }),
                ),
                await outcome(() => system.resolve(ctx, SUBJECT)),
            ].join(", "),
    },
    steer: {
        uses: true,
        touch: async (_world, system) =>
            await outcome(() => system.steer(ctx, SUBJECT, user("steered after the restart"))),
    },
    "update metadata": {
        uses: true,
        touch: async (_world, system) =>
            await outcome(() => system.updateMetadata(ctx, SUBJECT, { title: "renamed" })),
    },
    abort: {
        uses: true,
        touch: async (_world, system) => await outcome(() => system.abort(ctx, SUBJECT)),
    },
    compact: {
        uses: true,
        touch: async (_world, system) => await outcome(() => system.compact(ctx, SUBJECT)),
    },
    delete: {
        uses: true,
        touch: async (_world, system) => await outcome(() => system.delete(ctx, SUBJECT)),
    },
    "two callers resolving at once": {
        uses: true,
        touch: async (_world, system) =>
            await outcome(async () => {
                const [first, second] = await Promise.all([
                    system.resolve(ctx, SUBJECT),
                    system.resolve(ctx, SUBJECT),
                ]);
                expect(first).toBe(second);
            }),
    },
    "a resolve beside a transactional send": {
        uses: true,
        touch: async (world, system) =>
            (
                await Promise.all([
                    outcome(() => system.resolve(ctx, SUBJECT)),
                    outcome(() =>
                        world.dbCtx.inTx(
                            async (txCtx) =>
                                await system.send(txCtx, SUBJECT, user("beside a resolve")),
                        ),
                    ),
                ])
            ).join(", "),
    },
    "send while the collection drains": {
        uses: true,
        touch: async (_world, system) => {
            const draining = system.drain();
            const sent = await outcome(() =>
                system.send(ctx, SUBJECT, user("sent while draining")),
            );
            await draining;
            return sent;
        },
    },
};

interface Run {
    readonly afterStart: readonly string[];
    readonly outcome: string;
    readonly secondProcess: Record<string, unknown>;
    readonly thirdProcess: Record<string, unknown>;
    readonly answers: readonly string[];
    readonly logs: readonly (readonly string[])[];
    readonly probes: readonly Probe[];
}

/** Leave one state behind, touch it from the next process, and restart once more. */
async function runScenario(
    open: () => Promise<TestDatabase>,
    left: LeftBehind,
    touch: Touch,
    eager: boolean,
): Promise<Run> {
    const world = await World.open(open);
    const everyone = [SUBJECT, BYSTANDER, PARENT];
    const demand = (): readonly string[] =>
        eager ? everyone : left.named === true ? [SUBJECT] : [];
    try {
        const first = new Probe({ holdWaits: true });
        const firstSystem = await world.process(first);
        const bystander = await firstSystem.create(ctx, {}, { id: BYSTANDER });
        await bystander.send(ctx, user("bystander"));
        await bystander.waitForIdle();
        if (left.subtask === true) {
            const parent = await firstSystem.create(ctx, {}, { id: PARENT });
            await parent.send(ctx, user("parent"));
            await parent.waitForIdle();
        }
        if ((await left.leave(world, firstSystem, first)) === "abandon") world.abandon();
        else await firstSystem.close(ctx);

        const second = new Probe({ demand });
        const secondSystem = await world.process(second);
        const afterStart = [...second.restores.keys()].sort();
        const owing = left.owes && left.exists !== false ? [SUBJECT] : [];
        await settle(secondSystem, owing);
        const result = await touch.touch(world, secondSystem);
        if (touch.uses && (await world.exists(SUBJECT))) await settle(secondSystem, [SUBJECT]);
        await secondSystem.close(ctx);
        const secondProcess = await world.snapshot(everyone);

        const third = new Probe({ demand });
        const thirdSystem = await world.process(third);
        const live = await Promise.all(
            everyone.map(async (agentId) => await world.exists(agentId)),
        );
        // Whatever the second process left owed is resumed now, and settles.
        await settle(
            thirdSystem,
            everyone.filter(
                (agentId, index) => live[index] === true && third.restored(agentId) > 0,
            ),
        );
        await thirdSystem.close(ctx);
        return {
            afterStart,
            outcome: result,
            secondProcess,
            thirdProcess: await world.snapshot(everyone),
            answers: [...world.provider.answers].sort(),
            logs: [second.log, third.log].map((log) =>
                log.filter((entry) => !entry.startsWith("restored:")),
            ),
            probes: [second, third],
        };
    } finally {
        await world.close();
    }
}

describe.each(databaseBackends)("AgentSystemLocal lazy restoration ($label)", ({ open }) => {
    describe.each(Object.entries(LEFT_BEHIND))("an agent left %s", (_name, left) => {
        it.each(Object.entries(TOUCHES))("then touched by %s", async (_touchName, touch) => {
            const lazy = await runScenario(open, left, touch, false);
            const eager = await runScenario(open, left, touch, true);

            const exists = left.exists !== false;
            const owes = left.owes && exists;
            const named = left.named === true && exists;
            // The lazy start restores what owes work or is named, and nothing else.
            expect(lazy.afterStart).toEqual(owes || named ? [SUBJECT] : []);
            // The eager one restored every identity that existed.
            expect(eager.afterStart).toEqual(
                [SUBJECT, BYSTANDER, PARENT]
                    .filter((agentId) => agentId !== SUBJECT || exists)
                    .filter((agentId) => agentId !== PARENT || left.subtask === true)
                    .sort(),
            );
            const [second] = lazy.probes;
            // Used means restored, exactly once, and before any agent hook reached it.
            expect(second?.restored(SUBJECT)).toBe(exists && (owes || named || touch.uses) ? 1 : 0);
            expect(second?.restored(BYSTANDER)).toBe(0);
            expect(second?.restored(PARENT)).toBe(0);
            for (const probe of [...lazy.probes, ...eager.probes]) {
                expect(probe.unrestoredUses).toEqual([]);
                for (const count of probe.restores.values()) expect(count).toBe(1);
            }
            // Everything else is as the eager start left it.
            expect(lazy.outcome).toBe(eager.outcome);
            expect(lazy.secondProcess).toEqual(eager.secondProcess);
            expect(lazy.thirdProcess).toEqual(eager.thirdProcess);
            expect(lazy.answers).toEqual(eager.answers);
            expect(lazy.logs).toEqual(eager.logs);
        });
    });
});

describe.each(databaseBackends)("AgentSystemLocal restoration edges ($label)", ({ open }) => {
    async function withWorld(test: (world: World) => Promise<void>): Promise<void> {
        const world = await World.open(open);
        try {
            await test(world);
        } finally {
            await world.close();
        }
    }

    /** A first process that leaves every named agent created and settled. */
    async function settledAgents(world: World, agentIds: readonly string[]): Promise<void> {
        const system = await world.process(new Probe());
        for (const agentId of agentIds) {
            const agent = await system.create(ctx, {}, { id: agentId });
            await agent.send(ctx, user(`hello ${agentId}`));
            await agent.waitForIdle();
        }
        await system.close(ctx);
    }

    async function owe(world: World, agentId: string, text: string): Promise<void> {
        await world.write(agentId, "send.0001", queued(user(text)));
        await world.write(agentId, "owed", { stage: "inference", loopId: LOOP_ID });
    }

    it("restores an agent once when a transaction restores it while a resolve waits to", async () => {
        await withWorld(async (world) => {
            await settledAgents(world, [SUBJECT]);
            let entered!: () => void;
            const waiting = new Promise<void>((resolve) => {
                entered = resolve;
            });
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let armed = false;
            // Holds the resolve's own restoration transaction back until the other one commits.
            class GatedStorage extends AgentStorage {
                override async transaction<Result>(
                    txCtx: Context,
                    work: (ctx: Context, database: typeof this.database) => Promise<Result>,
                ): Promise<Result> {
                    if (armed && agentStorageTransaction(txCtx) === undefined) {
                        armed = false;
                        entered();
                        await gate;
                    }
                    return await super.transaction(txCtx, work);
                }
            }
            const probe = new Probe();
            const system = await world.process(probe, {
                storage: (options) => new GatedStorage(options),
            });
            armed = true;
            const resolving = system.resolve(ctx, SUBJECT);
            await waiting;
            await world.dbCtx.inTx(
                async (txCtx) => await system.send(txCtx, SUBJECT, user("while a resolve waits")),
            );
            release();
            const agent = await resolving;
            await agent.waitForIdle();

            expect(probe.restored(SUBJECT)).toBe(1);
            expect(probe.unrestoredUses).toEqual([]);
            expect(await system.resolve(ctx, SUBJECT)).toBe(agent);
            expect(world.provider.answers).toContain(`${SUBJECT}:while a resolve waits`);
            await system.close(ctx);
        });
    });

    it("restores an agent once when one transaction sends to it and then deletes it", async () => {
        await withWorld(async (world) => {
            await settledAgents(world, [SUBJECT]);
            const probe = new Probe();
            const system = await world.process(probe);
            await world.dbCtx.inTx(async (txCtx) => {
                await system.send(txCtx, SUBJECT, user("then deleted"));
                await system.delete(txCtx, SUBJECT);
            });

            expect(probe.restored(SUBJECT)).toBe(1);
            expect(probe.log.filter((entry) => !entry.startsWith("loop:"))).toEqual([
                `restored:${SUBJECT}`,
                `archived:${SUBJECT}`,
            ]);
            await system.close(ctx);
        });
    });

    it("never restores an agent this process created, deleted, or created again", async () => {
        await withWorld(async (world) => {
            const probe = new Probe();
            const system = await world.process(probe);
            await system.create(ctx, {}, { id: SUBJECT });
            await system.delete(ctx, SUBJECT);
            await world.dbCtx.inTx(async (txCtx) => {
                await system.create(txCtx, {}, { id: SUBJECT });
            });
            await world.dbCtx.inTx(async (txCtx) => {
                await system.create(txCtx, {}, { id: BYSTANDER });
                await system.delete(txCtx, BYSTANDER);
            });
            await system.send(ctx, SUBJECT, user("created again"));
            await (await system.resolve(ctx, SUBJECT)).waitForIdle();

            expect(probe.restores.size).toBe(0);
            expect(probe.unrestoredUses).toEqual([]);
            expect(probe.log).toEqual([
                `created:${SUBJECT}`,
                `archived:${SUBJECT}`,
                `created:${SUBJECT}`,
                `created:${BYSTANDER}`,
                `archived:${BYSTANDER}`,
                `loop:${SUBJECT}`,
                `inference:${SUBJECT}`,
            ]);
            await system.close(ctx);
        });
    });

    it("restores each agent once when messages reach it while the collection starts", async () => {
        await withWorld(async (world) => {
            const woken = ["wokenfirst", "wokensecond"];
            const idle = ["idlesent", "idletransaction", "idleafterstart"];
            await settledAgents(world, [...woken, ...idle]);
            for (const agentId of woken) await owe(world, agentId, `owed by ${agentId}`);
            const probe = new Probe({
                hooks: () => ({
                    // Restoration observers run while the collection starts, before any restored
                    // agent does, and reach the collection through the reference they are given.
                    agentRestored: async (hookCtx, scope, agent) => {
                        if (agent.id !== "wokenfirst") return;
                        await scope.agents.send(hookCtx, "idlesent", user("during start"));
                        await hookCtx.inTx(async (txCtx) => {
                            await scope.agents.send(
                                txCtx,
                                "idletransaction",
                                user("during start in a transaction"),
                            );
                            await scope.agents.send(
                                txCtx,
                                "wokensecond",
                                user("to a woken agent in a transaction"),
                            );
                        });
                    },
                    afterStart: async (startCtx, agents) => {
                        await agents.send(startCtx, "idleafterstart", user("after start"));
                    },
                }),
            });
            const system = await world.process(probe);
            await settle(system, [...woken, ...idle]);

            for (const agentId of [...woken, ...idle]) expect(probe.restored(agentId)).toBe(1);
            expect(probe.unrestoredUses).toEqual([]);
            expect(world.provider.answers).toEqual(
                expect.arrayContaining([
                    "wokenfirst:owed by wokenfirst",
                    "wokensecond:owed by wokensecond",
                    "wokensecond:to a woken agent in a transaction",
                    "idlesent:during start",
                    "idletransaction:during start in a transaction",
                    "idleafterstart:after start",
                ]),
            );
            await system.close(ctx);
        });
    });

    it("keeps one live agent when a transaction delivers to an owing agent as it starts", async () => {
        await withWorld(async (world) => {
            await settledAgents(world, ["wokenfirst", "wokensecond"]);
            await owe(world, "wokenfirst", "owed by wokenfirst");
            await owe(world, "wokensecond", "owed by wokensecond");
            let delivered!: () => void;
            const delivery = new Promise<void>((resolve) => {
                delivered = resolve;
            });
            // Holds the start's own load of the second agent until a transaction has delivered
            // to it, which builds and publishes an instance of its own. Outside a transaction,
            // the start reads the configuration once to restore the agent and again to load it.
            class HeldLoad extends AgentStorage {
                override persistence(agentId: string): AgentPersistence {
                    const persistence = super.persistence(agentId);
                    if (agentId !== "wokensecond") return persistence;
                    let reads = 0;
                    return new Proxy(persistence, {
                        get(target, property) {
                            if (property === "readValues") {
                                return async (readCtx: Context, prefix: string) => {
                                    if (
                                        prefix === "agentConfig" &&
                                        agentStorageTransaction(readCtx) === undefined
                                    ) {
                                        reads += 1;
                                        if (reads === 2) await delivery;
                                    }
                                    return await target.readValues(readCtx, prefix);
                                };
                            }
                            const value: unknown = Reflect.get(target, property, target);
                            return typeof value === "function" ? value.bind(target) : value;
                        },
                    });
                }
            }
            const probe = new Probe({
                hooks: () => ({
                    agentRestored: async (hookCtx, scope, agent) => {
                        if (agent.id !== "wokenfirst") return;
                        await hookCtx.inTx(
                            async (txCtx) =>
                                await scope.agents.send(
                                    txCtx,
                                    "wokensecond",
                                    user("delivered during start"),
                                ),
                        );
                        delivered();
                    },
                }),
            });
            const system = await world.process(probe, {
                storage: (options) => new HeldLoad(options),
            });
            await settle(system, ["wokenfirst", "wokensecond"]);

            expect(probe.restored("wokensecond")).toBe(1);
            expect(world.provider.answers).toEqual(
                expect.arrayContaining([
                    "wokensecond:owed by wokensecond",
                    "wokensecond:delivered during start",
                ]),
            );
            await system.close(ctx);
        });
    });

    it("fails only the use that needed a failed restoration, and restores on the next", async () => {
        await withWorld(async (world) => {
            await settledAgents(world, [SUBJECT, BYSTANDER]);
            let failures = 1;
            const failing: AgentModule = {
                name: "failing-restoration",
                beforeStart: () => ({
                    agentRestoredTransact: (_hookCtx, _scope, agent) => {
                        if (agent.id !== SUBJECT || failures === 0) return;
                        failures -= 1;
                        throw new Error("The restoration failed.");
                    },
                }),
            };
            const probe = new Probe();
            const system = await world.process(probe, { modules: [failing] });
            await expect(system.send(ctx, SUBJECT, user("lost"))).rejects.toThrow(
                "The restoration failed.",
            );
            expect(probe.restored(SUBJECT)).toBe(0);
            await system.send(ctx, SUBJECT, user("delivered"));
            await (await system.resolve(ctx, SUBJECT)).waitForIdle();

            expect(probe.restored(SUBJECT)).toBe(1);
            expect(world.provider.answers).toContain(`${SUBJECT}:delivered`);
            expect(world.provider.answers).not.toContain(`${SUBJECT}:lost`);
            await system.close(ctx);
        });
    });

    it("still refuses to start when an agent owing work cannot be restored", async () => {
        await withWorld(async (world) => {
            await settledAgents(world, [SUBJECT, BYSTANDER]);
            await owe(world, SUBJECT, "owed before the failure");
            const failing: AgentModule = {
                name: "failing-restoration",
                beforeStart: () => ({
                    agentRestoredTransact: () => {
                        throw new Error("The restoration failed.");
                    },
                }),
            };
            await expect(world.process(new Probe(), { modules: [failing] })).rejects.toThrow(
                "The restoration failed.",
            );
            // The failed start released the store, and the work is still owed.
            const probe = new Probe();
            const system = await world.process(probe);
            await settle(system, [SUBJECT]);
            expect(world.provider.answers).toContain(`${SUBJECT}:owed before the failure`);
            expect(probe.restored(BYSTANDER)).toBe(0);
            await system.close(ctx);
        });
    });
});

/** A small deterministic generator, so a failing history can be replayed from its seed. */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
}

const HISTORY_AGENTS = ["agenta", "agentb", "agentc", "agentd", "agente"];
const HISTORY_NEW_AGENT = "agentnew";

interface History {
    readonly comparable: Record<string, unknown>;
    readonly startRestored: readonly string[];
    readonly expectedRestored: readonly string[];
    readonly probes: readonly Probe[];
}

/**
 * Leave a random mix of states behind, run a random sequence of operations against the next
 * process, and restart once more. The same seed gives the same history whichever start runs it.
 */
async function runHistory(
    open: () => Promise<TestDatabase>,
    seed: number,
    eager: boolean,
): Promise<History> {
    const random = mulberry32(seed);
    const pick = <Value>(values: readonly Value[]): Value =>
        values[Math.floor(random() * values.length)] as Value;
    const everyone = [...HISTORY_AGENTS, HISTORY_NEW_AGENT];
    const world = await World.open(open);
    try {
        const first = new Probe({ holdWaits: true });
        const firstSystem = await world.process(first);
        const named: string[] = [];
        const deleted: string[] = [];
        const holding: string[] = [];
        for (const [index, agentId] of HISTORY_AGENTS.entries()) {
            const parent =
                index > 0 && random() < 0.4 ? pick(HISTORY_AGENTS.slice(0, index)) : undefined;
            const agent = await firstSystem.create(
                ctx,
                {},
                {
                    id: agentId,
                    ...(parent === undefined ? {} : { parent }),
                },
            );
            await agent.send(ctx, user(`hello ${agentId}`));
            await agent.waitForIdle();
            if (random() < 0.2) named.push(agentId);
            const state = random();
            if (state < 0.1) {
                await world.write(agentId, "send.0001", queued(user(`queued for ${agentId}`)));
            } else if (state < 0.3) {
                await world.write(agentId, "send.0001", queued(user(`owed by ${agentId}`)));
                await world.write(agentId, "owed", { stage: "inference", loopId: LOOP_ID });
            } else if (state < 0.4) {
                await world.write(agentId, "owed", { stage: "compaction", loopId: LOOP_ID });
            } else if (state < 0.5) {
                await world.write(agentId, "owed", { stage: "unreadable", loopId: LOOP_ID });
            } else if (state < 0.6) {
                deleted.push(agentId);
            } else if (state < 0.75) {
                await agent.send(ctx, user("wait"));
                await until(() => first.waiting.has(agentId));
                holding.push(agentId);
            }
        }
        for (const agentId of deleted) {
            await firstSystem.delete(ctx, agentId);
            await world.write(agentId, "send.0001", queued(user(`never for ${agentId}`)));
            await world.write(agentId, "owed", { stage: "inference", loopId: LOOP_ID });
        }
        if (holding.length > 0) await firstSystem.drain();
        await firstSystem.close(ctx);

        const demand = (): readonly string[] => (eager ? everyone : named);
        const second = new Probe({ demand });
        const secondSystem = await world.process(second);
        const startRestored = [...second.restores.keys()].sort();
        const owing = HISTORY_AGENTS.filter((agentId) => !deleted.includes(agentId)).filter(
            (agentId) => second.restored(agentId) > 0,
        );
        await settle(secondSystem, owing);
        // Every use of an existing agent restores it, unless this process created it.
        const expected = new Set(startRestored);
        const createdHere = new Set<string>();
        const outcomes: string[] = [];
        for (let step = 0; step < 10; step += 1) {
            const target = pick(everyone);
            const existed = await world.exists(target);
            const [name, uses, run] = pick<readonly [string, boolean, () => Promise<unknown>]>([
                ["config", false, () => secondSystem.config(ctx, target)],
                ["childOf", false, () => secondSystem.childOf(ctx, target)],
                ["create", false, () => secondSystem.create(ctx, {}, { id: target })],
                ["resolve", true, () => secondSystem.resolve(ctx, target)],
                ["send", true, () => secondSystem.send(ctx, target, user(`step ${step}`))],
                [
                    "send in a transaction",
                    true,
                    () =>
                        world.dbCtx.inTx(
                            async (txCtx) =>
                                await secondSystem.send(txCtx, target, user(`step ${step}`)),
                        ),
                ],
                [
                    "send rolled back",
                    false,
                    () =>
                        world.dbCtx.inTx(async (txCtx) => {
                            await secondSystem.send(txCtx, target, user(`rolled back ${step}`));
                            throw new Error("rolled back");
                        }),
                ],
                ["steer", true, () => secondSystem.steer(ctx, target, user(`step ${step}`))],
                [
                    "update metadata",
                    true,
                    () => secondSystem.updateMetadata(ctx, target, { title: `step ${step}` }),
                ],
                ["abort", true, () => secondSystem.abort(ctx, target)],
                ["compact", true, () => secondSystem.compact(ctx, target)],
                ["delete", true, () => secondSystem.delete(ctx, target)],
                [
                    "two resolves",
                    true,
                    () =>
                        Promise.all([
                            secondSystem.resolve(ctx, target),
                            secondSystem.resolve(ctx, target),
                        ]),
                ],
            ]);
            outcomes.push(`${name} ${target}: ${await outcome(run)}`);
            if (name === "create" && !existed && (await world.exists(target))) {
                createdHere.add(target);
            }
            if (uses && existed && !createdHere.has(target)) expected.add(target);
            if (uses && (await world.exists(target))) await settle(secondSystem, [target]);
        }
        await secondSystem.close(ctx);
        const afterSecond = await world.snapshot(everyone);

        const third = new Probe({ demand });
        const thirdSystem = await world.process(third);
        const live = await Promise.all(
            everyone.map(async (agentId) => await world.exists(agentId)),
        );
        await settle(
            thirdSystem,
            everyone.filter(
                (agentId, index) => live[index] === true && third.restored(agentId) > 0,
            ),
        );
        await thirdSystem.close(ctx);
        return {
            comparable: {
                outcomes,
                afterSecond,
                afterThird: await world.snapshot(everyone),
                answers: [...world.provider.answers].sort(),
                logs: [second.log, third.log].map((log) =>
                    log.filter((entry) => !entry.startsWith("restored:")).sort(),
                ),
            },
            startRestored,
            expectedRestored: [...expected].sort(),
            probes: [second, third],
        };
    } finally {
        await world.close();
    }
}

describe.each(databaseBackends)(
    "AgentSystemLocal lazy restoration, seeded ($label)",
    ({ open }) => {
        it("ends every seeded history where the eager start would have", async () => {
            const seeds = mulberry32(0x5eed_1a2b);
            for (let round = 0; round < 30; round += 1) {
                const seed = Math.floor(seeds() * 4_294_967_296);
                const lazy = await runHistory(open, seed, false);
                const eager = await runHistory(open, seed, true);

                expect({ seed, ...lazy.comparable }).toEqual({ seed, ...eager.comparable });
                const [second] = lazy.probes;
                expect({ seed, restored: [...(second?.restores.keys() ?? [])].sort() }).toEqual({
                    seed,
                    restored: lazy.expectedRestored,
                });
                for (const probe of [...lazy.probes, ...eager.probes]) {
                    expect({ seed, unrestoredUses: probe.unrestoredUses }).toEqual({
                        seed,
                        unrestoredUses: [],
                    });
                    for (const count of probe.restores.values())
                        expect({ seed, count }).toEqual({ seed, count: 1 });
                }
                const eagerSecond = eager.probes[0];
                for (const agentId of second?.restores.keys() ?? []) {
                    expect({ seed, agentId, eager: eagerSecond?.restored(agentId) }).toEqual({
                        seed,
                        agentId,
                        eager: 1,
                    });
                }
            }
        });
    },
);
