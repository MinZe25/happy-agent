import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import { agentSchema, type Agent, type AgentWait } from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const agent: Agent = {
    id: "agent1",
    workspaceId: "workspace1",
    parentAgentId: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    version,
    lastCursor: version,
    orderKey: "1",
    pendingQuestionId: null,
    processes: { running: 0 },
    subagents: { running: 0, total: 0 },
    status: "working",
    title: null,
    titleStatus: "idle",
    unread: null,
};

describe("agent wait protocol", () => {
    it("accepts older agents and explicit waiting or cleared intervals at every tree level", () => {
        expectTypeOf<Agent["wait"]>().toEqualTypeOf<AgentWait | null | undefined>();
        expect(Value.Check(agentSchema, agent)).toBe(true);
        expect(Value.Check(agentSchema, { ...agent, wait: null })).toBe(true);
        const wait: AgentWait = { startedAt: 10, dueAt: 100 };
        expect(Value.Check(agentSchema, { ...agent, wait })).toBe(true);
        expect(
            Value.Check(agentSchema, {
                ...agent,
                subtasks: [{ ...agent, id: "child1", parentAgentId: agent.id, wait }],
            }),
        ).toBe(true);
    });

    it.each([
        {},
        { startedAt: 10 },
        { dueAt: 100 },
        { startedAt: "10", dueAt: 100 },
        { startedAt: -1, dueAt: 100 },
        { startedAt: 10, dueAt: 1.5 },
        true,
    ])("rejects malformed intervals %j", (wait) => {
        expect(Value.Check(agentSchema, { ...agent, wait })).toBe(false);
        expect(
            Value.Check(agentSchema, {
                ...agent,
                subtasks: [{ ...agent, id: "child1", parentAgentId: agent.id, wait }],
            }),
        ).toBe(false);
    });
});
