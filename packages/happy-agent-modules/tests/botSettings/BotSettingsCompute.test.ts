import { withAgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BOT_SETTINGS } from "../../sources/botSettings/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { testConfig } from "../support/computeModule.js";
import { governedTree } from "./support.js";

const DOCKER = { ...DEFAULT_BOT_SETTINGS, compute: { type: "docker" as const, image: "node:22" } };

function onMachine(ctx: Context, compute: Record<string, unknown>): Context {
    return withAgentConfig(ctx, { modules: { compute } });
}

describe("bot settings compute", () => {
    it("builds a governed agent's machine in the bot's Docker image, and leaves a running one alone", async () => {
        const tree = await governedTree("bot-settings-compute-local");
        const hostMachines: FakeCompute[] = [];
        const module = ComputeModule.withProvider(
            testConfig,
            new SecretsModule(tree.botSettings),
            {
                id: "host",
                create: async (_ctx, config) => {
                    const compute = new FakeCompute(config.cwd);
                    hostMachines.push(compute);
                    return compute;
                },
            },
            undefined,
            tree.botSettings,
        );
        try {
            const ctx = onMachine(tree.ctx, { cwd: "/workspace/bot" });
            // Built before the bot chose Docker, so it stays on the host until it is rebuilt.
            const running = await module.resolve(ctx, "botagent");
            expect(running?.kind).not.toBe("docker");

            await tree.botSettings.write(tree.ctx, "botagent", DOCKER);
            await expect(module.resolve(ctx, "botagent")).resolves.toBe(running);
            const subtask = await module.resolve(ctx, "subtaskagent");
            expect(subtask).toMatchObject({ kind: "docker", cwd: "/workspace/bot" });
            // An agent the bot does not govern keeps the host machine.
            const other = await module.resolve(ctx, "otherchild");
            expect(other?.kind).not.toBe("docker");
            expect(hostMachines).toHaveLength(2);
        } finally {
            await module.dispose(tree.ctx);
            tree.close();
        }
    });

    it("hands the bot's image to a runner, unless the agent's workspace has its own", async () => {
        const tree = await governedTree("bot-settings-compute-runner");
        // A runner's machine is a plain object, the way the compute package builds one.
        const agentMachine = vi.fn(async (_ctx: Context, options: { readonly cwd: string }) => {
            const machine = new FakeCompute(options.cwd);
            return {
                id: "runner",
                kind: machine.kind,
                cwd: machine.cwd,
                fs: machine.fs,
                shell: machine.shell,
                dispose: async (ctx: Context) => await machine.dispose(ctx),
            };
        });
        const module = new ComputeModule(
            testConfig,
            new SecretsModule(tree.botSettings),
            { agentMachine, assertLocalExecution: vi.fn() } as never,
            tree.botSettings,
        );
        try {
            await tree.botSettings.write(tree.ctx, "botagent", DOCKER);
            await module.resolve(
                onMachine(tree.ctx, { cwd: "/srv/bot", runnerId: "studio" }),
                "subtaskagent",
            );
            await module.resolve(
                onMachine(tree.ctx, {
                    cwd: "/srv/project",
                    runnerId: "studio",
                    docker: { image: "project-image:1" },
                }),
                "collaboratoragent",
            );
            await module.resolve(
                onMachine(tree.ctx, { cwd: "/srv/other", runnerId: "studio" }),
                "otherchild",
            );

            expect(agentMachine.mock.calls.map(([, options]) => options)).toEqual([
                expect.objectContaining({
                    agentId: "subtaskagent",
                    runnerId: "studio",
                    docker: { image: "node:22" },
                }),
                expect.objectContaining({
                    agentId: "collaboratoragent",
                    docker: { image: "project-image:1" },
                }),
                expect.not.objectContaining({ docker: expect.anything() }),
            ]);
        } finally {
            await module.dispose(tree.ctx);
            tree.close();
        }
    });
});
