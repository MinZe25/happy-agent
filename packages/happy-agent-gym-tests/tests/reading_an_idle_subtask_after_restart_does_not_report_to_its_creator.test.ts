import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("idle subtasks after a daemon restart", () => {
    it("reads an idle subtask without running it or reporting to its creator", async () => {
        let coordinatorId = "";
        let coordinatorRequests = 0;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "<title>Idle subtask</title>", type: "text" }] };
                }
                if (request.sessionId !== coordinatorId) {
                    return { content: [{ text: "SUBTASK_FINAL_ANSWER", type: "text" }] };
                }
                coordinatorRequests += 1;
                if (coordinatorRequests === 1) {
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Finish and report your exact answer.",
                                    title: "Idle subtask probe",
                                },
                                callId: "idlesubtaskcreate",
                                name: "create_subtask",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return {
                    content: [{ text: `COORDINATOR_ANSWER_${coordinatorRequests}`, type: "text" }],
                };
            },
        });
        running.add(gym);
        const { bot } = await gym.client.createBot({ name: "Idle subtask coordinator" });
        coordinatorId = bot.agent.id;
        const coordinatorInferences = () =>
            gym.inference.requests.filter((request) => request.sessionId === coordinatorId);
        const subtaskInferences = () =>
            gym.inference.requests.filter(
                (request) =>
                    request.sessionId !== coordinatorId && !request.sessionId.startsWith("naming:"),
            );

        await gym.send("Create the subtask.", { sessionId: coordinatorId, wait: false });
        await gym.waitUntil(
            () =>
                coordinatorInferences().find((request) =>
                    JSON.stringify(request.messages).includes("SUBTASK_FINAL_ANSWER"),
                ),
            "the coordinator to receive the subtask's answer",
            20_000,
        );
        await gym.waitUntil(async () => {
            const events = await gym.sessionEvents(coordinatorId);
            return JSON.stringify(events).includes(`COORDINATOR_ANSWER_${coordinatorRequests}`)
                ? events
                : undefined;
        }, "the coordinator to answer the report");
        const subtask = (await gym.client.getAgentActivity(coordinatorId)).subagents[0];
        if (subtask === undefined) throw new Error("The subtask was not created.");
        const subtaskRequestsBeforeRestart = subtaskInferences().length;
        expect(subtaskRequestsBeforeRestart).toBeGreaterThan(0);

        await gym.restart();
        // Opening the subtask's chat after the restart resolves it from storage.
        await gym.client.markAgentRead(subtask.id);
        await gym.send("Anything new?", { sessionId: coordinatorId });

        const lastCoordinatorRequest = JSON.stringify(coordinatorInferences().at(-1)?.messages);
        expect(lastCoordinatorRequest).toContain("Anything new?");
        expect(lastCoordinatorRequest).not.toContain("stopped without answering");
        expect(subtaskInferences()).toHaveLength(subtaskRequestsBeforeRestart);
        const history = await gym.client.getMessages(coordinatorId);
        expect(JSON.stringify(history)).not.toContain("stopped without answering");
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);
});
