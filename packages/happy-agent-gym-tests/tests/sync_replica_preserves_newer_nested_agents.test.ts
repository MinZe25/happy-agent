import { expect, it } from "vitest";
import { mergeOwnerAgents } from "./helpers/mergeOwnerAgents.js";

it("preserves newer agents while project and workspace snapshots control membership and order", () => {
    const old = {
        id: "moved",
        version: "01991f3a-5d2b-7000-8000-000000000001",
        updatedAt: 1,
        orderKey: "5",
    };
    const newer = {
        ...old,
        version: "01991f3a-5d2b-7000-8000-000000000002",
        updatedAt: 2,
        orderKey: "6",
    };
    const sibling = { ...old, id: "sibling", orderKey: "7" };
    const removed = { ...old, id: "removed" };
    const known = new Map([newer, sibling, removed].map((agent) => [agent.id, agent]));

    const projectAgents = mergeOwnerAgents([sibling, old], known);
    expect(projectAgents).toEqual([sibling, newer]);
    expect(projectAgents.map((agent) => agent.id)).toEqual(["sibling", "moved"]);
    const workspaceAgents = mergeOwnerAgents([old], known);
    expect(workspaceAgents).toEqual([newer]);
    expect(known.get("moved")).toEqual(newer);

    const latest = { ...newer, version: "01991f3a-5d2b-7000-8000-000000000003", updatedAt: 3 };
    expect(mergeOwnerAgents([latest, sibling], known)).toEqual([latest, sibling]);
    expect(known.get("moved")).toEqual(latest);
});
