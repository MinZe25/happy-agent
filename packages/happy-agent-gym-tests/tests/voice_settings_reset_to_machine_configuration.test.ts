import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("resets runtime voice fast mode through the public PATCH to the machine value", async () => {
    const gym = await createAgentGym({ config: "[voice]\ncontroller_fast_mode=true\n" });
    running.add(gym);
    expect((await gym.client.getConfig()).config.voice?.controller.fastMode).toBe(true);
    expect(
        (await gym.client.patchConfig({ voice: { controller: { fastMode: false } } })).config.voice
            ?.controller.fastMode,
    ).toBe(false);
    // Raw transport lets this regression run against the old client type too.
    expect(
        await gym.raw.patch("/v0/config", { voice: { controller: { fastMode: null } } }),
    ).toMatchObject({
        status: 200,
        body: { config: { voice: { controller: { fastMode: true } } } },
    });
    expect((await gym.client.getConfig()).config.voice?.controller.fastMode).toBe(true);
    await gym.restart();
    expect((await gym.client.getConfig()).config.voice?.controller.fastMode).toBe(true);
    expect(gym.errors).toEqual([]);
}, 30_000);
