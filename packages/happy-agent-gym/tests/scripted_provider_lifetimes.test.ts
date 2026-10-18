import type { AgentProviders } from "@slopus/happy-agent-base";
import type { BaseProvider, BaseSession } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it } from "vitest";

import {
    createScriptedInference,
    GYM_MODEL_ID,
    GYM_MODELS,
    type ScriptedInference,
} from "../sources/index.js";

const ctx = createRootContext().named("test.scripted-provider-lifetimes");

it.each(["array", "handler"] as const)(
    "rebuilds providers while preserving %s script progress, logs and per-provider run/compaction indexes",
    async (kind) => {
        const providerIds = ["first", "second"];
        const scripted = createScriptedInference({
            providerIds,
            models: GYM_MODELS,
            inference:
                kind === "array"
                    ? [...providerIds, ...providerIds].map((providerId, index) => ({
                          providerId,
                          content: [{ type: "text", text: `${providerId}:${String(index)}` }],
                      }))
                    : (request) => ({
                          content: [
                              {
                                  type: "text",
                                  text: `${request.providerId}:${String(request.callIndex)}`,
                              },
                          ],
                      }),
        });
        const createProviders = providerFactory(scripted);
        const initialRegistry = scripted.providers;
        const log = scripted.log;
        const references = {
            requests: log.requests,
            compactions: log.compactions,
            unscripted: log.unscripted,
            userTexts: log.userTexts,
            toolResults: log.toolResults,
            lastTools: log.lastTools,
        };
        const registries = new Set<AgentProviders>();
        const instances = new Set<BaseProvider>();
        const sessions: BaseSession[] = [];
        try {
            for (let start = 0; start < 2; start += 1) {
                const registry = createProviders();
                expect(registry).not.toBe(initialRegistry);
                expect(registries.has(registry)).toBe(false);
                registries.add(registry);
                for (const [providerIndex, providerId] of providerIds.entries()) {
                    const provider = await registry.resolve(providerId, GYM_MODEL_ID);
                    expect(provider).not.toBeNull();
                    if (provider === null) throw new Error("The fixture provider is missing.");
                    expect(instances.has(provider)).toBe(false);
                    instances.add(provider);
                    expect(await registry.resolve(providerId, GYM_MODEL_ID)).toBe(provider);
                    expect(await initialRegistry.resolve(providerId, GYM_MODEL_ID)).not.toBe(
                        provider,
                    );
                    const session = await provider.session(`${providerId}:${String(start)}`, {
                        instructions: "Answer the fixture.",
                        tools: [],
                    });
                    sessions.push(session);
                    await session.compact(ctx, {
                        context: { instructions: "", messages: [] },
                        model: GYM_MODEL_ID,
                    });
                    expect(log.compactions.at(-1)?.callIndex).toBe(start);
                    const callIndex = kind === "array" ? start * 2 + providerIndex : start;
                    expect(await runText(session, `${providerId} start ${String(start)}`)).toBe(
                        `${providerId}:${String(callIndex)}`,
                    );
                    await session.compact(ctx, {
                        context: { instructions: "", messages: [] },
                        model: GYM_MODEL_ID,
                    });
                    expect(log.compactions.at(-1)?.callIndex).toBe(start + 1);
                }
            }
            expect(instances.size).toBe(4);
            expect(scripted.providers).toBe(initialRegistry);
            expect(scripted.models).toBe(GYM_MODELS);
            expect(scripted.log).toBe(log);
            for (const key of [
                "requests",
                "compactions",
                "unscripted",
                "userTexts",
                "toolResults",
                "lastTools",
            ] as const) {
                expect(scripted.log[key]).toBe(references[key]);
            }
            expect(
                log.requests.map(({ providerId, callIndex }) => ({ providerId, callIndex })),
            ).toEqual(
                [...providerIds, ...providerIds].map((providerId, index) => ({
                    providerId,
                    callIndex: kind === "array" ? index : Math.floor(index / 2),
                })),
            );
            expect(
                log.compactions.map(({ sessionId, callIndex }) => ({ sessionId, callIndex })),
            ).toEqual([
                { sessionId: "first:0", callIndex: 0 },
                { sessionId: "first:0", callIndex: 1 },
                { sessionId: "second:0", callIndex: 0 },
                { sessionId: "second:0", callIndex: 1 },
                { sessionId: "first:1", callIndex: 1 },
                { sessionId: "first:1", callIndex: 2 },
                { sessionId: "second:1", callIndex: 1 },
                { sessionId: "second:1", callIndex: 2 },
            ]);
            expect(log.last).toBe(log.requests.at(-1));
            expect(log.userTexts()).toEqual([
                "first start 0",
                "second start 0",
                "first start 1",
                "second start 1",
            ]);
            expect(log.toolResults()).toEqual([]);
            expect(log.lastTools()).toEqual([]);
            expect(log.unscripted).toEqual([]);
        } finally {
            await Promise.all(sessions.map(async (session) => await session.destroy()));
        }
    },
);

function providerFactory(scripted: ScriptedInference): () => AgentProviders {
    const factory: unknown = Reflect.get(scripted, "createProviders");
    expect(factory, "the restart-safe provider factory exists").toBeTypeOf("function");
    return factory as () => AgentProviders;
}

async function runText(session: BaseSession, prompt: string): Promise<string> {
    let text = "";
    for await (const event of session.run(ctx, {
        context: {
            instructions: "",
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        },
        model: GYM_MODEL_ID,
    })) {
        if (event.type === "text_delta") text += event.delta;
    }
    return text;
}
