import { PassThrough, type Duplex } from "node:stream";

import { withAgentConfig } from "@slopus/happy-agent-base";
import type { ComputeConnectOptions } from "@slopus/happy-agent-compute";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { ComputeModule, SecretsModule, type HostComputeProvider } from "../../sources/index.js";
import { testConfig } from "../support/computeModule.js";
import { FakeCompute } from "./support/FakeCompute.js";

const ctx = createRootContext().named("happy-agent-modules-compute-network");

/** A machine that records every connection asked of it, by the machine's own name. */
class NetworkedCompute extends FakeCompute {
    readonly opened: string[] = [];
    readonly connections: Duplex[] = [];
    readonly network = {
        connect: async (_ctx: Context, options: ComputeConnectOptions): Promise<Duplex> => {
            this.opened.push(`${this.cwd} ${options.host}:${String(options.port)}`);
            const connection = new PassThrough();
            this.connections.push(connection);
            return connection;
        },
    };
}

function configured(cwd: string) {
    return withAgentConfig(ctx, { modules: { compute: { cwd } } });
}

function machines(): {
    readonly module: ComputeModule;
    readonly computes: Map<string, NetworkedCompute>;
} {
    const computes = new Map<string, NetworkedCompute>();
    const provider: HostComputeProvider = {
        id: "host",
        create: async (_createCtx, config) => {
            const compute = new NetworkedCompute(config.cwd);
            computes.set(config.cwd, compute);
            return compute;
        },
    };
    return {
        module: ComputeModule.withProvider(testConfig, new SecretsModule(), provider),
        computes,
    };
}

describe("ComputeModule.network", () => {
    it("opens every connection from the agent's own machine and ends them with it", async () => {
        const { module, computes } = machines();
        const connectA = await module.network(configured("/workspace/a"), "agent-a");
        const connectB = await module.network(configured("/workspace/b"), "agent-b");

        const first = await connectA(ctx, { host: "localhost", port: 3000 });
        const other = await connectB(ctx, { host: "localhost", port: 3000 });
        expect(computes.get("/workspace/a")?.opened).toEqual(["/workspace/a localhost:3000"]);
        expect(computes.get("/workspace/b")?.opened).toEqual(["/workspace/b localhost:3000"]);

        await module.archiveAgent(ctx, "agent-a");
        expect(first.destroyed).toBe(true);
        expect(other.destroyed).toBe(false);
        // The archived machine is gone; its connector never starts another one.
        await expect(connectA(ctx, { host: "localhost", port: 3000 })).rejects.toMatchObject({
            code: "ECONNREFUSED",
        });
        expect(computes.get("/workspace/a")?.opened).toHaveLength(1);

        await module.dispose(ctx);
        expect(other.destroyed).toBe(true);
        await expect(connectB(ctx, { host: "localhost", port: 3000 })).rejects.toThrow();
    });

    it("refuses an agent whose machine cannot open connections", async () => {
        const provider: HostComputeProvider = {
            id: "host",
            create: async (_createCtx, config) => new FakeCompute(config.cwd),
        };
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), provider);
        await expect(module.network(configured("/workspace"), "agent-a")).rejects.toMatchObject({
            code: "ENOTSUP",
        });
        await module.dispose(ctx);
    });
});
