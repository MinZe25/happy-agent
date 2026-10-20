import type { SessionOptions, SessionRunRequest, SessionStream } from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase } from "../sources/index.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-steered-response");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => (resolve = settle));
    return { promise, resolve };
}

/**
 * A provider that runs its own agent loop: its first response keeps going until steering is
 * accepted, then ends so the steering is delivered on the next run.
 */
class LoopSession extends ScriptedSession {
    readonly started = deferred<void>();

    override run(runCtx: Context, request: SessionRunRequest): SessionStream {
        if (this.requests.length > 0) return super.run(runCtx, request);
        this.requests.push(request);
        const started = this.started;
        return (async function* () {
            started.resolve();
            const steered = request.steered;
            if (steered === undefined) throw new Error("The response carries no steering signal.");
            await new Promise<void>((resolve) => {
                if (steered.aborted) resolve();
                steered.addEventListener("abort", () => resolve(), { once: true });
            });
            yield* textTurn("interrupted");
        })();
    }
}

class LoopProvider extends ScriptedProvider {
    readonly opened = deferred<LoopSession>();

    override session(id: string, options: SessionOptions): Promise<ScriptedSession> {
        const session = new LoopSession(id, [textTurn("after steering")], options);
        this.sessions.push(session);
        this.opened.resolve(session);
        return Promise.resolve(session);
    }
}

describe("steering a response in flight", () => {
    it("raises the response's steered signal so a provider looping on its own lets steering in", async () => {
        const provider = new LoopProvider([]);
        const agent = await AgentBase.create(ctx, {
            id: "steered-response",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });

        await agent.send(ctx, user("start a long job"));
        const session = await provider.opened.promise;
        await session.started.promise;
        expect(session.requests[0]!.steered?.aborted).toBe(false);

        await agent.steer(ctx, user("stop and do this instead"));
        await agent.waitForIdle();

        expect(session.requests[0]!.steered?.aborted).toBe(true);
        expect(session.requests).toHaveLength(2);
        const last = session.requests[1]!.context.messages.at(-1);
        expect(JSON.stringify(last)).toContain("stop and do this instead");
        // The next response gets a fresh signal of its own.
        expect(session.requests[1]!.steered?.aborted).toBe(false);
        await agent.close();
    });
});
