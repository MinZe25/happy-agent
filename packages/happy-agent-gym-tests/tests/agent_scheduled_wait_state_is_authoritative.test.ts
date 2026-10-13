import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function waitingAgent(seconds = 60) {
    const gym = await createAgentGym({
        inference: [
            {
                content: [
                    {
                        type: "tool_call",
                        name: "wait",
                        callId: "scheduledwait",
                        arguments: { duration: { seconds } },
                    },
                ],
            },
            { content: [{ type: "text", text: "The wait ended." }] },
            { content: [{ type: "text", text: "The next message was received." }] },
        ],
    });
    running.add(gym);
    const accepted = await gym.send("Wait for the scheduled time.", { wait: false });
    const event = await gym.waitForEvent(
        (event) =>
            event.type === "agent.updated" &&
            event.payload.agentId === gym.defaultSessionId &&
            event.payload.changes.wait != null,
        "the authoritative scheduled wait update",
    );
    if (event.type !== "agent.updated" || event.payload.changes.wait == null)
        throw new Error("No interval on the wait update.");
    return { gym, accepted, wait: event.payload.changes.wait, event };
}

describe("authoritative scheduled wait state", () => {
    it("carries a subtask's wait_until interval through bot and desktop bootstrap trees", async () => {
        let coordinatorId: string | undefined;
        let coordinatorCalls = 0;
        const childCalls = new Map<string, number>();
        const dueAt = Date.now() + 60_000;
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:"))
                    return {
                        content: [{ type: "text", text: "<title>Scheduled subtask</title>" }],
                    };
                if (request.sessionId === coordinatorId) {
                    if (coordinatorCalls++ === 0)
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "create_subtask",
                                    callId: "createwaitingchild",
                                    arguments: {
                                        title: "Waiting child",
                                        text: "Wait until the given time.",
                                        model: "gym/model",
                                        effort: "medium",
                                        provider: "gym",
                                    },
                                },
                            ],
                        };
                    return { content: [{ type: "text", text: "Delegated." }] };
                }
                const calls = childCalls.get(request.sessionId) ?? 0;
                childCalls.set(request.sessionId, calls + 1);
                return calls === 0
                    ? {
                          content: [
                              {
                                  type: "tool_call",
                                  name: "wait_until",
                                  callId: "childdatedwait",
                                  arguments: { at: dueAt },
                              },
                          ],
                      }
                    : { content: [{ type: "text", text: "Child finished." }] };
            },
        });
        running.add(gym);
        const { bot } = await gym.client.createBot({ name: "Wait coordinator" });
        coordinatorId = bot.agent.id;
        await gym.send("Create a waiting subtask.", { sessionId: coordinatorId, wait: false });
        const event = await gym.waitForEvent(
            (event) => event.type === "agent.updated" && event.payload.changes.wait != null,
            "the child's dated wait",
        );
        if (event.type !== "agent.updated" || event.payload.changes.wait == null)
            throw new Error("No child interval.");
        const childId = event.payload.agentId;
        const wait = event.payload.changes.wait;
        expect(wait.dueAt).toBe(dueAt);
        expect((await gym.client.getAgent(childId)).agent.wait).toEqual(wait);
        expect(
            (await gym.client.getBot(bot.id)).bot.agent.subtasks?.find(
                (child) => child.id === childId,
            )?.wait,
        ).toEqual(wait);
        const bootstrap = await gym.client.getDesktopBootstrap();
        expect(
            bootstrap.bots
                ?.find((item) => item.id === bot.id)
                ?.agent.subtasks?.find((child) => child.id === childId)?.wait,
        ).toEqual(wait);
        await gym.client.abortAgent(childId);
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(childId)).agent.wait === null ? true : undefined,
            "the child wait to clear",
        );
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 30_000);

    it("exposes entering and expiring waits consistently in snapshots and versioned events", async () => {
        const { gym, accepted, wait, event } = await waitingAgent(2);
        expect(wait.dueAt - wait.startedAt).toBe(2_000);
        expect(event.payload.version > event.payload.previousVersion).toBe(true);
        const focused = (await gym.client.getAgent(gym.defaultSessionId)).agent;
        expect(focused.wait).toEqual(wait);
        expect(focused.status).not.toBe("idle");
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).agent.wait).toEqual(wait);
        const desktop = await gym.client.getDesktopBootstrap();
        const catalogAgent = [
            ...desktop.projects.flatMap((project) => project.agents),
            ...desktop.workspaces.flatMap((workspace) => workspace.agents),
        ].find((agent) => agent.id === gym.defaultSessionId);
        expect(catalogAgent?.wait).toEqual(wait);

        const cleared = await gym.waitForEvent(
            (event) =>
                event.type === "agent.updated" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.changes.wait === null,
            "the elapsed wait to clear",
        );
        expect(cleared.occurredAt).toBeGreaterThanOrEqual(wait.dueAt);
        await gym.waitForRun(accepted.runId!);
        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.wait).toBeNull();
        expect(gym.inference.toolResults()).toContainEqual(
            expect.objectContaining({
                callId: "scheduledwait",
                text: expect.stringContaining("finished"),
            }),
        );
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 30_000);

    it.each(["queue", "steer"] as const)(
        "clears a wait when a %s message arrives",
        async (delivery) => {
            const { gym } = await waitingAgent();
            const reply =
                delivery === "steer"
                    ? await gym.steer("Finish the wait now.", { wait: false })
                    : await gym.send("Finish the wait now.", { wait: false });
            await gym.waitForEvent(
                (event) =>
                    event.type === "agent.updated" &&
                    event.payload.agentId === gym.defaultSessionId &&
                    event.payload.changes.wait === null,
                "the message to interrupt the wait",
            );
            await gym.waitUntil(async () => {
                const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
                return bootstrap.pending.length === 0 && bootstrap.agent.status === "idle"
                    ? true
                    : undefined;
            }, "the interrupted wait and new message to settle");
            expect((await gym.client.getAgent(gym.defaultSessionId)).agent.wait).toBeNull();
            expect(gym.inference.userTexts()).toContain("Finish the wait now.");
            expect(reply.id).toBeDefined();
            expect(gym.errors).toEqual([]);
        },
        30_000,
    );

    it.each(["abort", "archive"] as const)(
        "clears a wait on %s",
        async (action) => {
            const { gym } = await waitingAgent();
            if (action === "abort") await gym.abort();
            else await gym.client.archiveAgent(gym.defaultSessionId);
            await gym.waitForEvent(
                (event) =>
                    event.type === "agent.updated" &&
                    event.payload.agentId === gym.defaultSessionId &&
                    event.payload.changes.wait === null,
                "the canceled wait to clear",
            );
            expect((await gym.client.getAgent(gym.defaultSessionId)).agent.wait).toBeNull();
            expect(gym.errors).toEqual([]);
        },
        30_000,
    );

    it("preserves the original active interval across a daemon restart", async () => {
        const { gym, wait } = await waitingAgent();
        await gym.restart();
        const resumed = await gym.waitUntil(async () => {
            const { agent } = await gym.client.getAgent(gym.defaultSessionId);
            return agent.wait == null ? undefined : agent;
        }, "the same durable wait after restart");
        expect(resumed.wait).toEqual(wait);
        expect((await gym.client.getAgentBootstrap(gym.defaultSessionId)).agent.wait).toEqual(wait);
        await gym.abort();
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(gym.defaultSessionId)).agent.wait === null
                    ? true
                    : undefined,
            "the resumed wait to clear on abort",
        );
        expect(gym.errors).toEqual([]);
    }, 30_000);
});
