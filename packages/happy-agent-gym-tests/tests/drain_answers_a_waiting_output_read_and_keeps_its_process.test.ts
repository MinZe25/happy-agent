import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

/** A poll may wait five minutes; the drain must not wait with it. */
const POLL_WAIT_MS = 300_000;

describe("a drain that starts during a waiting output read", () => {
    it("answers the read at once, commits its result, and leaves the process running", async () => {
        let agentCall = 0;
        let polledSession: number | undefined;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest) => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "Drain during a poll", type: "text" }] };
                }
                const call = agentCall;
                agentCall += 1;
                if (call === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: "sleep 120",
                                    max_output_tokens: 1_000,
                                    yield_time_ms: 250,
                                },
                                callId: "startbenchmark",
                                name: "exec_command",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (call === 1) {
                    polledSession = Number(
                        /session ID (\d+)/u.exec(JSON.stringify(request.messages))?.[1],
                    );
                    return {
                        content: [
                            {
                                arguments: {
                                    chars: "",
                                    session_id: polledSession,
                                    yield_time_ms: POLL_WAIT_MS,
                                },
                                callId: "pollbenchmark",
                                name: "write_stdin",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return { content: [{ text: "The benchmark is still running.", type: "text" }] };
            },
            timeoutMs: 15_000,
        });
        running.add(gym);
        const agentRequests = () =>
            gym.inference.requests.filter((request) => request.sessionId === gym.defaultSessionId);
        const pollStatus = (status: "completed" | "running") =>
            gym.waitForEvent(
                (event) =>
                    event.type === "message.updated" &&
                    event.payload.agentId === gym.defaultSessionId &&
                    event.payload.message.content.some(
                        (block) =>
                            block.type === "tool_call" &&
                            block.name === "write_stdin" &&
                            block.status === status,
                    ),
                `the poll to be ${status}`,
            );

        await gym.send("Start the benchmark and wait for it.", {
            permissionMode: "full_access",
            wait: false,
        });
        await pollStatus("running");
        const process = await gym.waitUntil(async () => {
            const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
            return activity.processes.find((candidate) => candidate.status === "running");
        }, "the running benchmark");

        const drainStartedAt = Date.now();
        await expect(gym.client.drain()).resolves.toMatchObject({ draining: true });
        await gym.waitUntil(async () => {
            const health = await gym.client.getHealth();
            return health.draining === true && health.drainWaitingFor?.length === 0
                ? health
                : undefined;
        }, "the daemon to finish draining");
        expect(Date.now() - drainStartedAt).toBeLessThan(10_000);

        // The read answered through its ordinary result, which is committed to history.
        const completed = await pollStatus("completed");
        expect(JSON.stringify(completed)).toContain(
            `Process running with session ID ${String(polledSession)}`,
        );
        expect(JSON.stringify(completed)).toContain("Happy Agent is restarting");
        // The drain released only the wait: the benchmark is still running, and no new inference
        // started after the batch reached its edge.
        const activity = await gym.client.getAgentActivity(gym.defaultSessionId);
        expect(activity.processes).toContainEqual(
            expect.objectContaining({ id: process.id, status: "running" }),
        );
        expect(agentRequests()).toHaveLength(2);
        expect(gym.inference.unscripted).toEqual([]);

        // The daemon log says what held the drain and for how long, naming work, never content.
        const log = await gym.waitUntil(async () => {
            const text = await readFile(
                join(gym.happyHome, "agent", "observation", "agent.log"),
                "utf8",
            ).catch(() => "");
            return text.includes("daemon:drain:finish") ? text : undefined;
        }, "the drain to be logged");
        expect(log).toMatch(/daemon:drain:start pid=\d+/u);
        expect(log).toMatch(/daemon:drain:waiting [^\n]*blockers=[^\n]*write_stdinx1/u);
        expect(log).toMatch(/daemon:drain:finish pid=\d+ durationMs=\d+/u);
        expect(log).not.toContain(String(POLL_WAIT_MS));
    }, 60_000);
});
