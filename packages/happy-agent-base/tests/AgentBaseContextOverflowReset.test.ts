import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase, type AgentBaseHooks, type AgentBaseModelChange } from "../sources/index.js";
import { providersOf, system, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("context-overflow-reset-test");

const overflow: SessionEvent[] = [
    { type: "done", state: "error", kind: "context_overflow", message: "prompt is too long" },
];
const handoff = system("The earlier conversation was reset because it outgrew the context.");
const failureNote = (message: string) => system(`The last turn failed: ${message}`);
const assistant = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
});

function setup(script: SessionEvent[][], modelChanged?: AgentBaseHooks["modelChanged"] | null) {
    const persistence = new InMemoryPersistence();
    const provider = new ScriptedProvider(script);
    const changes: AgentBaseModelChange[] = [];
    const events: SessionEvent[] = [];
    const options = {
        id: "overflowing-agent",
        provider: "scripted",
        model: "anthropic/opus-5-5",
        persistence,
        providers: providersOf(provider),
        hooks: {
            ...(modelChanged === null
                ? {}
                : {
                      modelChanged: async (hookCtx, change) => {
                          changes.push(change);
                          return modelChanged === undefined
                              ? handoff
                              : await modelChanged(hookCtx, change);
                      },
                  }),
            onEvent: (_ctx, event) => {
                events.push(event);
            },
        } satisfies AgentBaseHooks,
    };
    return { persistence, provider, changes, events, options };
}

const requestMessages = (provider: ScriptedProvider) =>
    provider.sessions.flatMap((session) => session.requests.map((r) => r.context.messages));

describe("a context overflow before any visible output", () => {
    it("resets the private context once and retries the turn in it", async () => {
        const { provider, changes, events, options } = setup([
            textTurn("First answer"),
            overflow,
            textTurn("Recovered answer"),
            textTurn("Follow-up answer"),
        ]);
        let agent = await AgentBase.create(ctx, options);
        try {
            await agent.send(ctx, user("First request"));
            await agent.waitForIdle();
            await agent.send(ctx, user("Second request"));
            await agent.waitForIdle();

            expect(changes).toEqual([
                expect.objectContaining({
                    previousModel: "anthropic/opus-5-5",
                    model: "anthropic/opus-5-5",
                    previousProvider: "scripted",
                    provider: "scripted",
                    wasReset: true,
                    reason: "context_overflow",
                }),
            ]);
            expect(provider.sessions[0]?.destroyed).toBe(true);
            expect(requestMessages(provider)).toEqual([
                [user("First request")],
                [user("First request"), assistant("First answer"), user("Second request")],
                [handoff, user("Second request")],
            ]);
            expect(events).toContainEqual(
                expect.objectContaining({ type: "retrying", attempt: 1 }),
            );
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });

            // The reset is durable: a restarted agent continues from the fresh context.
            await agent.close();
            agent = await AgentBase.load(ctx, options);
            await agent.send(ctx, user("Third request"));
            await agent.waitForIdle();
            expect(requestMessages(provider).at(-1)).toEqual([
                handoff,
                user("Second request"),
                assistant("Recovered answer"),
                user("Third request"),
            ]);
        } finally {
            await agent.close();
        }
    });

    it("reports the failure when the retry overflows too", async () => {
        const { provider, changes, events, options } = setup([
            overflow,
            overflow,
            textTurn("Later answer"),
        ]);
        const agent = await AgentBase.create(ctx, options);
        try {
            await agent.send(ctx, user("Too much"));
            await agent.waitForIdle();

            expect(changes).toHaveLength(1);
            expect(
                events.filter((event) => event.type === "done" && event.state === "error"),
            ).toHaveLength(2);
            await agent.send(ctx, user("Next"));
            await agent.waitForIdle();
            expect(requestMessages(provider).at(-1)).toEqual([
                handoff,
                user("Too much"),
                failureNote("prompt is too long"),
                user("Next"),
            ]);
        } finally {
            await agent.close();
        }
    });

    it("resets without a handoff when no module offers one", async () => {
        const { provider, options } = setup([overflow, textTurn("Recovered")], null);
        const agent = await AgentBase.create(ctx, options);
        try {
            await agent.send(ctx, user("Only request"));
            await agent.waitForIdle();
            expect(requestMessages(provider)).toEqual([
                [user("Only request")],
                [user("Only request")],
            ]);
            expect(provider.sessions).toHaveLength(2);
        } finally {
            await agent.close();
        }
    });
});

describe("a context overflow that is not reset", () => {
    it.each([
        {
            name: "after visible output",
            response: [
                { type: "text_start" },
                { type: "text_delta", delta: "Partial" },
                { type: "text_end" },
                ...overflow,
            ] as SessionEvent[],
            failedWith: [assistant("Partial"), failureNote("prompt is too long")],
        },
        {
            name: "for another error kind",
            response: [
                { type: "done", state: "error", kind: "unknown", message: "model overloaded" },
            ] as SessionEvent[],
            failedWith: [failureNote("model overloaded")],
        },
    ])("keeps the history $name", async ({ response, failedWith }) => {
        const { provider, changes, options } = setup([response, textTurn("Later")]);
        const agent = await AgentBase.create(ctx, options);
        try {
            await agent.send(ctx, user("Request"));
            await agent.waitForIdle();
            await agent.send(ctx, user("Next"));
            await agent.waitForIdle();
            expect(changes).toEqual([]);
            expect(requestMessages(provider).at(-1)).toEqual([
                user("Request"),
                ...failedWith,
                user("Next"),
            ]);
        } finally {
            await agent.close();
        }
    });

    it("keeps the history when the handoff hook refuses the reset", async () => {
        const { provider, changes, options } = setup([overflow, textTurn("Later")], () => {
            throw new Error("No handoff today.");
        });
        const agent = await AgentBase.create(ctx, options);
        try {
            await agent.send(ctx, user("Request"));
            await agent.waitForIdle();
            await agent.send(ctx, user("Next"));
            await agent.waitForIdle();
            expect(changes).toHaveLength(1);
            expect(provider.sessions[0]?.destroyed).toBe(false);
            expect(requestMessages(provider).at(-1)).toEqual([
                user("Request"),
                failureNote("prompt is too long"),
                user("Next"),
            ]);
        } finally {
            await agent.close();
        }
    });
});
