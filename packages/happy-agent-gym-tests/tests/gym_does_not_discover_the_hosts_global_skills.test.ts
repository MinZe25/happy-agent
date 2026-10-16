import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { expect, it, vi } from "vitest";

it("does not discover global skills from the home inherited by the test process", async () => {
    const inheritedHome = await mkdtemp(join(tmpdir(), "gym-inherited-home-"));
    const skillDirectory = join(inheritedHome, ".agents", "skills", "host-only-probe");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
        join(skillDirectory, "SKILL.md"),
        "---\nname: host-only-probe\ndescription: A skill owned by the inherited home.\n---\nThis must never enter a gym.\n",
    );
    vi.stubEnv("HOME", inheritedHome);
    let gym: AgentGym | undefined;
    try {
        gym = await createAgentGym();
        const agent = await gym.client.getAgent(gym.defaultSessionId);
        expect(agent.slashCommands?.map((command) => command.name)).not.toContain(
            "host-only-probe",
        );
        // The emulated machine already isolates agent skills. The native global-skills catalog
        // needs the same boundary: discovery and watchers must never open the inherited home.
        const catalog = await gym.client.listGlobalSkills();
        expect(catalog.skills.map((skill) => skill.name)).not.toContain("host-only-probe");
        expect(gym.errors).toEqual([]);
    } finally {
        await gym?.dispose();
        vi.unstubAllEnvs();
        await rm(inheritedHome, { recursive: true, force: true });
    }
}, 30_000);
