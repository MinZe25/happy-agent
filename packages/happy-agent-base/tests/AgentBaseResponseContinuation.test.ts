import { Type } from "@sinclair/typebox";
import type { SessionEvent, SessionMessage } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AGENT_BASE_PENDING_KEY, AgentBase, defineAgentTool } from "../sources/index.js";
import { providersOf, system, textTurn, user, userRecord } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-base-response-continuation");
const CONTINUATION = system("Continue from where you left off.");
const PARTIAL = "Meanwhile, drafting the PR body.";

/** A response whose one block finished before the stream ended, optionally with its outcome. */
function partialTurn(text: string, done?: SessionEvent): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        ...(done === undefined ? [] : [done]),
    ];
}

function assistantText(text: string): SessionMessage {
    return { role: "assistant", content: [{ type: "text", text }] };
}

const lookupTool = defineAgentTool({
    name: "lookup",
    returnType: Type.Object({}),
    shouldReviewInAutoMode: () => false,
    execute: () => Promise.resolve({}),
    toLLM: () => [{ type: "text", text: "looked up" }],
});

function lookupTurn(): SessionEvent[] {
    return [
        { type: "toolcall_start", callId: "lookup-call", name: "lookup" },
        { type: "toolcall_end", callId: "lookup-call", arguments: "{}" },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

// Claude 4.6 and later reject a conversation that ends with the model's own message, and Opus 5.5
// binds each thinking block to every message before it. A request continuing a response that left
// finished blocks therefore follows a durable notice that every later request repeats.
describe("a continued response", () => {
    it("follows a durable notice when a cut-off answer to a notice is reopened", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            textTurn("Started the build in the background."),
            partialTurn(PARTIAL),
            textTurn("Drafted the PR body."),
        ]);
        const notice = system("The background build finished.");
        let injected = false;
        const agent = await AgentBase.create(ctx, {
            id: "notice-reopen",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                afterAgentLoop: () => {
                    if (injected) return undefined;
                    injected = true;
                    return [{ type: "inject", message: notice }];
                },
            },
        });

        await agent.send(ctx, user("Open the PR once the build passes."));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(3);
        expect(requests[1]?.context.messages.at(-1)).toEqual(notice);
        expect(requests[2]?.context.messages.slice(-3)).toEqual([
            notice,
            assistantText(PARTIAL),
            CONTINUATION,
        ]);
        expect(persistence.records.slice(-3)).toEqual([
            { type: "block", block: { type: "text", text: PARTIAL } },
            { type: "system", message: CONTINUATION },
            { type: "block", block: { type: "text", text: "Drafted the PR body." } },
        ]);
        await agent.close();
    });

    it("keeps the notice in place across later requests and reloads after a restart", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("question"),
            { type: "block", block: { type: "text", text: PARTIAL } },
        ]);
        persistence.values.set(AGENT_BASE_PENDING_KEY, {
            stage: "inference",
            loopId: "l12345678901234567890123",
            inferenceId: "i12345678901234567890123",
        });
        const provider = new ScriptedProvider([
            lookupTurn(),
            textTurn("Done."),
            textTurn("Still here."),
        ]);
        const options = {
            id: "restart-resume",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            initialState: { tools: [lookupTool] },
        };
        const agent = await AgentBase.load(ctx, options);

        agent.start();
        await agent.waitForIdle();
        await agent.close();

        const continued = [user("question"), assistantText(PARTIAL), CONTINUATION];
        const first = provider.sessions[0]?.requests ?? [];
        expect(first).toHaveLength(2);
        expect(first[0]?.context.messages).toEqual(continued);
        // The continuation's own blocks follow the notice rather than merging into the
        // interrupted response, so the prefix stays byte-stable for the next request.
        expect(first[1]?.context.messages.slice(0, 3)).toEqual(continued);
        expect(first[1]?.context.messages[3]).toMatchObject({
            role: "assistant",
            content: [{ type: "tool_call", name: "lookup" }],
        });

        // A reload rebuilds the conversation from records, where the notice still separates the
        // two responses.
        const reloaded = await AgentBase.load(ctx, options);
        await reloaded.send(ctx, user("Anything else?"));
        await reloaded.waitForIdle();

        const later = provider.sessions[1]?.requests ?? [];
        expect(later).toHaveLength(1);
        expect(later[0]?.context.messages.slice(0, 3)).toEqual(continued);
        expect(later[0]?.context.messages.at(-1)).toEqual(user("Anything else?"));
        expect(
            persistence.records.filter(
                (record) => record.type === "system" && record.message.role === "system",
            ),
        ).toHaveLength(1);
        await reloaded.close();
    });

    it("follows a durable notice when Ethan mode retries a failed partial response", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            partialTurn("partial answer", {
                type: "done",
                state: "error",
                kind: "unknown",
                message: "model overloaded",
            }),
            textTurn("recovered"),
        ]);
        const agent = await AgentBase.create(ctx, {
            id: "ethan-retry",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            retryForever: true,
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[0]?.context.messages).toEqual([user("go")]);
        expect(requests[1]?.context.messages).toEqual([
            user("go"),
            assistantText("partial answer"),
            CONTINUATION,
        ]);
        await agent.close();
    });

    it("adds no notice when the conversation already ends with input", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const agent = await AgentBase.create(ctx, {
            id: "no-continuation",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("one"));
        await agent.send(ctx, user("two"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.requests.at(-1)?.context.messages.at(-1)).toEqual(user("two"));
        expect(persistence.records.some((record) => record.type === "system")).toBe(false);
        await agent.close();
    });
});
