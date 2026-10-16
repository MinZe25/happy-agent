import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("separators are not a Surface type", () => {
    it("refuses separator creation without creating, joining, or announcing anything", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const list = (await client.createSurface({ type: "todo", name: "Inbox" })).surface;
        for (const request of [
            { type: "separator", name: "Work" },
            { type: "separator", name: "Work", id: "separatorsurface00000001" },
        ] as const)
            await expect(client.createSurface(request)).rejects.toMatchObject({
                status: 400,
                code: "invalid_request",
            });
        await expect(client.joinSurface("separatorsurface00000001")).rejects.toMatchObject({
            status: 404,
        });
        expect((await client.listSurfaces()).surfaces).toEqual([list]);
        const events = (await client.getEvents({ limit: 1000 })).events;
        expect(events.filter((event) => event.type === "surface.created")).toMatchObject([
            { payload: { surface: { id: list.id } } },
        ]);
        await gym.restart();
        expect((await gym.client.getDesktopBootstrap()).surfaces).toEqual([list]);
        expect(gym.errors).toEqual([]);
    });
});
