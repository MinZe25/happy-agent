import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexProvider, type BaseProvider, type SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";
import { ScriptedSession, type ScriptedTurn } from "../support/ScriptedProvider.js";

afterEach(() => vi.restoreAllMocks());
const request = { context: { instructions: "test", messages: [] } };

async function fixture(script: ScriptedTurn[]) {
    const root = await mkdtemp(join(tmpdir(), "credential-session-"));
    const session = Object.assign(new ScriptedSession("cached", script, { instructions: "test" }), {
        cwd: "native working directory",
        pathToClaudeCodeExecutable: "native executable",
    });
    const prototype: BaseProvider = CodexProvider.prototype;
    vi.spyOn(prototype, "session").mockResolvedValue(session);
    const config = await testConfigRootedAt(
        root,
        `
[node]
name = "private"
[providers]
default_enable = false
[providers.account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-key"
`,
    );
    return {
        session,
        async open() {
            const provider = await config.providers.resolve("account", "openai/gpt-5.6-sol");
            if (provider === null) throw new Error("Missing fixture provider.");
            return await provider.session("cached", { instructions: "test" });
        },
        async close() {
            await session.destroy();
            await config.closeProviders();
            await rm(root, { recursive: true, force: true });
        },
    };
}

it("decorates a cached native session once while preserving identity and one call-through", async () => {
    const failure: SessionEvent = {
        type: "done",
        state: "error",
        kind: "unknown",
        message: "Authentication failed on private",
    };
    const owned = await fixture([[failure], [failure]]);
    try {
        const first = await owned.open();
        const initial: SessionEvent[] = [];
        for await (const event of first.run(createRootContext(), request)) initial.push(event);
        const firstRun = first.run;
        const firstCompact = first.compact;
        const second = await owned.open();
        expect(second).toBe(first);
        expect(second).toBe(owned.session);
        expect(second.run).toBe(firstRun);
        expect(second.compact).toBe(firstCompact);
        expect(second).toMatchObject({
            cwd: "native working directory",
            pathToClaudeCodeExecutable: "native executable",
        });
        const repeated: SessionEvent[] = [];
        for await (const event of second.run(createRootContext(), request)) repeated.push(event);
        expect(initial[0]).not.toEqual(failure);
        expect(repeated).toEqual(initial);
        expect(owned.session.requests).toHaveLength(2);
    } finally {
        await owned.close();
    }
});

it("forwards iterator throw and return to the native generator", async () => {
    const interruption = new Error("Caller-supplied iterator interruption.");
    let caught: unknown;
    let closed = 0;
    const owned = await fixture([
        async function* () {
            try {
                try {
                    yield { type: "block_start" };
                } catch (error) {
                    caught = error;
                }
                yield { type: "done", state: "cancelled" };
            } finally {
                closed += 1;
            }
        },
    ]);
    try {
        const session = await owned.open();
        const iterator = session.run(createRootContext(), request)[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toEqual({ type: "block_start" });
        expect((await iterator.throw!(interruption)).value).toEqual({
            type: "done",
            state: "cancelled",
        });
        expect(caught).toBe(interruption);
        expect(await iterator.return!("caller return")).toEqual({
            done: true,
            value: "caller return",
        });
        expect(closed).toBe(1);
        expect(owned.session.requests).toHaveLength(1);
    } finally {
        await owned.close();
    }
});

it("closes the native iterator once when a caller breaks early", async () => {
    let closed = 0;
    const owned = await fixture([
        async function* () {
            try {
                yield { type: "block_start" };
                yield { type: "text_start" };
            } finally {
                closed += 1;
            }
        },
    ]);
    try {
        const session = await owned.open();
        for await (const _event of session.run(createRootContext(), request)) break;
        expect(closed).toBe(1);
        expect(owned.session.requests).toHaveLength(1);
    } finally {
        await owned.close();
    }
});
