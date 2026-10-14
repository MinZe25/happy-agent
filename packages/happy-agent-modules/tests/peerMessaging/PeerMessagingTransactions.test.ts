import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModuleScope, AgentSystemRef } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";
import { PeerMessagingModule } from "../../sources/peerMessaging/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import {
    durableFunctionsHarness,
    pendingCallCount,
    waitForCondition,
} from "../durableFunctions/support/durableFunctionsHarness.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "peer-transactions-"));
    cleanup.push(async () => await rm(root, { recursive: true, force: true }));
    const config = await ConfigModule.load(join(root, ".happy"));
    const durable = await durableFunctionsHarness("peer-transactions", { start: false });
    cleanup.push(async () => durable.close());
    let admin = true;
    const bots = {
        forAgent: async (_ctx: unknown, id: string) =>
            id === "chief" ? { isAdmin: admin, status: "active" } : undefined,
    } as unknown as BotsModule;
    const module = new PeerMessagingModule(config, bots, durable.module);
    const hooks = module.beforeStart(durable.database.context, {} as AgentSystemRef);
    await durable.start();
    cleanup.push(async () => await module.close(durable.database.context));
    return {
        config,
        module,
        hooks,
        durable,
        ctx: durable.database.context,
        revoke: () => {
            admin = false;
        },
    };
}
describe("peer settings durable transaction boundary", () => {
    it("rolls back intent without changing files and applies a committed intent after commit", async () => {
        const f = await fixture();
        await expect(
            f.ctx.inTx(async (txCtx) => {
                expect(
                    await f.module.configure(txCtx, "chief", { node_id: "rolled-back" }),
                ).toEqual({ accepted: true });
                expect(f.config.peerMessaging).toEqual({});
                expect(await pendingCallCount(txCtx)).toBe(1);
                throw new Error("Rollback");
            }),
        ).rejects.toThrow("Rollback");
        expect(await pendingCallCount(f.ctx)).toBe(0);
        expect(f.config.peerMessaging).toEqual({});
        await f.ctx.inTx(async (txCtx) => {
            await f.module.configure(txCtx, "chief", { node_id: "committed" });
            expect(f.config.peerMessaging).toEqual({});
        });
        await waitForCondition(() => f.config.peerMessaging.node_id === "committed");
        expect(
            (await ConfigModule.load(f.config.configuration.paths.happyHome)).peerMessaging.node_id,
        ).toBe("committed");
    });
    it("rechecks admin authority at execution and declares reviewed external boundaries on real tools", async () => {
        const f = await fixture();
        const scope = { agent: { id: "chief" } } as AgentModuleScope;
        const tools = await f.hooks.tools!(f.ctx, scope);
        expect(tools.map((tool) => tool.name)).toEqual([
            "configure_peer_messaging",
            "set_peer_connection",
            "remove_peer_connection",
            "check_peer_connection",
            "debug_peer_connections",
        ]);
        const debug = tools.find((tool) => tool.name === "debug_peer_connections")!;
        const configure = tools.find((tool) => tool.name === "configure_peer_messaging")!;
        expect(configure.requiresAutoOrFullAccess).toBe(true);
        expect(configure.transactional).toBe(true);
        expect(configure.shouldRunInFullAccessInAutoMode).toBeDefined();
        expect(configure.shouldReviewInAutoMode).toBeDefined();
        f.revoke();
        await expect(debug.execute(f.ctx, {}, { id: "call" } as never)).rejects.toThrow(
            "active admin bot",
        );
        await expect(f.module.check(f.ctx, "chief", "remote")).rejects.toThrow("active admin bot");
        expect(await f.hooks.tools!(f.ctx, scope)).toEqual([]);
    });
});
