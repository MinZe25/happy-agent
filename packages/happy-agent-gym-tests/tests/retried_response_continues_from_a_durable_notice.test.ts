import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

const PERSISTED = "Meanwhile, drafting the PR body.";
const CONTINUATION = "Continue from where you left off.";

// Claude rejects a request whose conversation ends with the model's own message, and binds each
// thinking block to the exact messages before it. A response that failed after a finished block
// must be continued from a durable notice, so the retry and every later request share one prefix.
describe("a response retried in Ethan mode", () => {
    it("continues from a durable notice instead of from its own finished block", async () => {
        let agentCall = 0;
        const gym = await createAgentGym({
            config: "[settings.ethan]\nenabled = true\n",
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "Retried response", type: "text" }] };
                }
                agentCall += 1;
                if (agentCall === 1) {
                    return {
                        content: [{ text: PERSISTED, type: "text" }],
                        error: { kind: "unknown", message: "model overloaded" },
                    };
                }
                return { content: [{ text: `answer ${String(agentCall)}`, type: "text" }] };
            },
        });
        running.add(gym);
        const agentRequests = () =>
            gym.inference.requests.filter((request) => request.sessionId === gym.defaultSessionId);

        await gym.send("Open the PR when the build finishes.");

        const [failed, retried] = agentRequests();
        expect(agentRequests()).toHaveLength(2);
        expect(failed!.messages.at(-1)?.role).toBe("user");
        const continued = retried!.messages.slice(failed!.messages.length);
        expect(continued).toMatchObject([
            { content: [{ text: PERSISTED, type: "text" }], role: "assistant" },
            { content: [{ text: CONTINUATION, type: "text" }], role: "system" },
        ]);

        await gym.send("Thanks.");

        const followUp = agentRequests()[2]!;
        expect(followUp.messages.slice(0, retried!.messages.length)).toEqual(retried!.messages);
        expect(followUp.messages.at(-1)?.role).toBe("user");
    }, 60_000);
});
