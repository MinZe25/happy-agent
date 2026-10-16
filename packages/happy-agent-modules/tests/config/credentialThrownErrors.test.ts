import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, type BaseProvider, type BaseSession } from "@slopus/happy-providers";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";
import type { ConfigModule } from "../../sources/config/index.js";
import type { AgentEvent } from "../../sources/events/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { diagnosticRuntime } from "../support/diagnosticRuntime.js";
import { ScriptedSession } from "../support/ScriptedProvider.js";

afterEach(() => vi.restoreAllMocks());
const selector = "providers.private_account.api_key";
const context = { instructions: "test", messages: [] };
const suffix = "The request was not accepted.\n\nRetry this conversation.";
class FixtureAuthenticationError extends Error {
    readonly code = "AUTHENTICATION_FAILED";
    readonly status = 401;
    readonly diagnostics = { type: "authentication", status: 401 };
}
const configuration = `
[providers]
default_enable = false
[providers.private_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-private-key"
[providers.router]
type = "smart"
enabled = true
providers = ["private_account"]
[defaults]
provider = "router"
model = "openai/gpt-5.6-sol"
`;

it.each(["run", "session"] as const)(
    "cleans a %s throw before the real router, history and settlement see it",
    async (operation) => {
        const failure = new FixtureAuthenticationError(
            `Authentication failed at ${selector}.\n\n${suffix}`,
        );
        const prototype: BaseProvider = CodexProvider.prototype;
        vi.spyOn(prototype, "session").mockImplementation(async (id, options) => {
            if (operation === "session") throw failure;
            return new ScriptedSession(
                id,
                [
                    async function* () {
                        yield { type: "block_start" };
                        throw failure;
                    },
                ],
                options,
            );
        });
        const fixture = await diagnosticRuntime(configuration);
        const events: AgentEvent[] = [];
        const agent = fixture.agent!;
        const unsubscribe = fixture.runtime.modules.events.subscribe((event) => {
            if (event.agentId === agent.id) events.push(event);
        });
        try {
            await fixture.client.sendMessage(agent.id, {
                text: "Exercise the credential exception.",
                mode: {
                    providerId: "router",
                    modelId: "openai/gpt-5.6-sol",
                    effort: "medium",
                    serviceTier: null,
                    permissionMode: "auto",
                },
            });
            await vi.waitFor(
                async () =>
                    expect(
                        (await fixture.client.getMessages(agent.id)).runs.some(
                            (run) => run.status === "failed",
                        ),
                    ).toBe(true),
                { timeout: 10_000, interval: 10 },
            );
            const done = events.findLast(
                (event) =>
                    event.type === "provider.event" &&
                    (event.payload as { event?: { type?: string } }).event?.type === "done",
            );
            expect(done?.payload).toMatchObject({
                event: { type: "done", state: "error", providerError: { type: "authentication" } },
            });
            const settlement = events.find((event) => event.type === "loop.settled");
            expect(settlement).toBeDefined();
            for (const value of [await fixture.client.getMessages(agent.id), settlement, events]) {
                expect(JSON.stringify(value)).not.toContain(selector);
                expect(JSON.stringify(value)).toContain(JSON.stringify(suffix).slice(1, -1));
            }
            expect(failure.message).toContain(selector);
        } finally {
            unsubscribe();
            await fixture.close();
        }
    },
    30_000,
);

it.each(["run", "compact", "session"] as const)(
    "clones a sensitive %s throw without changing its prototype or routing fields",
    async (operation) => {
        const root = await mkdtemp(join(tmpdir(), "credential-throw-"));
        const cause = new Error(`Credential source: ${selector}`);
        const failure = new FixtureAuthenticationError(`Authentication failed at ${selector}`, {
            cause,
        });
        let config: ConfigModule | undefined;
        let session: BaseSession | undefined;
        try {
            const prototype: BaseProvider = CodexProvider.prototype;
            vi.spyOn(prototype, "session").mockImplementation(async (id, options) => {
                if (operation === "session") throw failure;
                const result = new ScriptedSession(
                    id,
                    [
                        async function* () {
                            yield { type: "block_start" };
                            throw failure;
                        },
                    ],
                    options,
                );
                vi.spyOn(result, "compact").mockRejectedValue(failure);
                return result;
            });
            config = await testConfigRootedAt(root, configuration);
            const provider = await config.providers.resolve(
                "private_account",
                "openai/gpt-5.6-sol",
            );
            if (provider === null) throw new Error("Missing fixture provider.");
            const received = await (async () => {
                session = await provider.session("conversation", { instructions: "test" });
                if (operation === "compact")
                    await session.compact(createRootContext(), { context });
                else
                    for await (const _event of session.run(createRootContext(), { context })) {
                        /* drain */
                    }
            })().catch((error: unknown) => error);
            expect(received).toBeInstanceOf(FixtureAuthenticationError);
            expect(received).not.toBe(failure);
            expect(received).toMatchObject({
                name: failure.name,
                code: failure.code,
                status: 401,
                diagnostics: failure.diagnostics,
            });
            const error = received as Error;
            for (const text of [error.message, error.stack, (error.cause as Error)?.message])
                expect(text).not.toContain(selector);
            expect(failure.message).toContain(selector);
            expect(cause.message).toContain(selector);
        } finally {
            await session?.destroy();
            await config?.closeProviders();
            await rm(root, { recursive: true, force: true });
        }
    },
);

it.each(["run", "compact", "session"] as const)(
    "rethrows an unrelated %s failure as the identical object",
    async (operation) => {
        const root = await mkdtemp(join(tmpdir(), "credential-identity-"));
        const failure = new Error("An unrelated fixture failure.");
        let config: ConfigModule | undefined;
        let session: BaseSession | undefined;
        try {
            const prototype: BaseProvider = CodexProvider.prototype;
            vi.spyOn(prototype, "session").mockImplementation(async (id, options) => {
                if (operation === "session") throw failure;
                const result = new ScriptedSession(
                    id,
                    [
                        async function* () {
                            yield { type: "block_start" };
                            throw failure;
                        },
                    ],
                    options,
                );
                vi.spyOn(result, "compact").mockRejectedValue(failure);
                return result;
            });
            config = await testConfigRootedAt(root, configuration);
            const provider = await config.providers.resolve(
                "private_account",
                "openai/gpt-5.6-sol",
            );
            if (provider === null) throw new Error("Missing fixture provider.");
            const received = await (async () => {
                session = await provider.session("conversation", { instructions: "test" });
                if (operation === "compact")
                    await session.compact(createRootContext(), { context });
                else
                    for await (const _event of session.run(createRootContext(), { context })) {
                        /* drain */
                    }
            })().catch((error: unknown) => error);
            expect(received).toBe(failure);
        } finally {
            await session?.destroy();
            await config?.closeProviders();
            await rm(root, { recursive: true, force: true });
        }
    },
);

it("preserves an abort reason's identity and the provider's cancelled terminal event", async () => {
    const root = await mkdtemp(join(tmpdir(), "credential-abort-"));
    const controller = new AbortController();
    const reason = new Error("Intentional fixture interruption.");
    let observedReason: unknown;
    let config: ConfigModule | undefined;
    let session: BaseSession | undefined;
    try {
        const prototype: BaseProvider = CodexProvider.prototype;
        vi.spyOn(prototype, "session").mockImplementation(
            async (id, options) =>
                new ScriptedSession(
                    id,
                    [
                        async function* (ctx) {
                            yield { type: "block_start" };
                            observedReason = ctx.lifetime?.reason;
                            if (ctx.lifetime?.aborted) yield { type: "done", state: "cancelled" };
                        },
                    ],
                    options,
                ),
        );
        config = await testConfigRootedAt(root, configuration);
        const provider = await config.providers.resolve("private_account", "openai/gpt-5.6-sol");
        if (provider === null) throw new Error("Missing fixture provider.");
        session = await provider.session("conversation", { instructions: "test" });
        const iterator = session
            .run(withLifetime(createRootContext(), controller.signal), { context })
            [Symbol.asyncIterator]();
        expect((await iterator.next()).value).toEqual({ type: "block_start" });
        controller.abort(reason);
        expect((await iterator.next()).value).toEqual({ type: "done", state: "cancelled" });
        expect(observedReason).toBe(reason);
        expect(controller.signal.reason).toBe(reason);
        await iterator.return?.();
    } finally {
        await session?.destroy();
        await config?.closeProviders();
        await rm(root, { recursive: true, force: true });
    }
});

it("withholds a real discovery filesystem exception's selected auth-file path from history and settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "credential-discovery-"));
    const authFile = join(root, "synthetic-auth.json");
    // A self-referential symlink deterministically yields ELOOP including this owned path.
    await symlink(authFile, authFile);
    let fixture: Awaited<ReturnType<typeof diagnosticRuntime>> | undefined;
    try {
        fixture = await diagnosticRuntime(
            configuration.replace('api_key = "synthetic-private-key"', `auth_file = "${authFile}"`),
        );
        const events: AgentEvent[] = [];
        const agent = fixture.agent!;
        const unsubscribe = fixture.runtime.modules.events.subscribe((event) => {
            if (event.agentId === agent.id) events.push(event);
        });
        try {
            await fixture.client.sendMessage(agent.id, {
                text: "Exercise credential discovery.",
                mode: {
                    providerId: "router",
                    modelId: "openai/gpt-5.6-sol",
                    effort: "medium",
                    serviceTier: null,
                    permissionMode: "auto",
                },
            });
            await vi.waitFor(
                async () =>
                    expect(
                        (await fixture!.client.getMessages(agent.id)).runs.some(
                            (run) => run.status === "failed",
                        ),
                    ).toBe(true),
                { timeout: 10_000, interval: 10 },
            );
            const settlement = events.find((event) => event.type === "loop.settled");
            expect(settlement).toBeDefined();
            for (const value of [await fixture.client.getMessages(agent.id), events, settlement])
                expect(JSON.stringify(value)).not.toContain(authFile);
        } finally {
            unsubscribe();
        }
    } finally {
        await fixture?.close();
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
