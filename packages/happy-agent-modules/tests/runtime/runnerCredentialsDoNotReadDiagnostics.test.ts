import { HappyAgentApiError, HappyAgentClient } from "@slopus/happy-agent-client";
import { expect, it } from "vitest";
import { diagnosticRuntime } from "../support/diagnosticRuntime.js";

it("does not admit a configured runner's real token to message history or events", async () => {
    const token = "r".repeat(43);
    const fixture = await diagnosticRuntime(
        `[runners.build-box]\nname = "Build box"\ntoken = "${token}"\n`,
    );
    try {
        const caller = new HappyAgentClient({
            endpoint: fixture.endpoint,
            token,
        });
        for (const read of [
            () => caller.getMessages("syntheticagent"),
            () => caller.getEvents(),
            () => caller.streamEvents().next(),
        ]) {
            const outcome = await read().catch((error: unknown) => error);
            expect(outcome).toBeInstanceOf(HappyAgentApiError);
            expect((outcome as HappyAgentApiError).status).toBe(401);
            expect((outcome as HappyAgentApiError).body).toEqual({
                error: "Unauthorized",
                code: "unauthorized",
            });
        }
    } finally {
        await fixture.close();
    }
}, 30_000);
