import {
    agentDatabaseRows,
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { SurfacesModule } from "../../sources/surfaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const close: (() => void)[] = [];
afterEach(() => {
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

async function fixture() {
    const durable = new DurableFunctionsModule();
    let adminActive = true;
    const bots = {
        forAgent: async (_ctx: unknown, id: string) =>
            id === "admin"
                ? { isAdmin: true, status: adminActive ? "active" : "archived" }
                : undefined,
    } as unknown as BotsModule;
    const team = {
        enabled: true,
        getUser: async (_ctx: unknown, id: string) =>
            ["alice", "bob"].includes(id) ? { id, authentication: "jwt" } : undefined,
    } as unknown as TeamModule;
    const compute = {
        resolve: vi.fn(async () => ({})),
        shouldReviewPath: vi.fn(async () => false),
    };
    const surfaces = new SurfacesModule(durable, team, bots, compute as unknown as ComputeModule);
    const db = moduleDatabase([...durable.migrations, ...surfaces.migrations], "surfaces-test");
    ensureAgentDatabaseConnection(db.database);
    close.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    const hooks = surfaces.beforeStart(db.context);
    return {
        surfaces,
        db,
        hooks,
        compute,
        revoke: () => {
            adminActive = false;
        },
    };
}

describe("installation-owned Surface state", () => {
    it("keeps each person's ordering independent and validates administrative targets", async () => {
        const { surfaces: s, db } = await fixture();
        const ctx = db.context;
        const a = await s.create(ctx, { type: "todo", name: "A" }, "alice");
        const b = await s.create(ctx, { type: "todo", name: "B" }, "alice");
        await s.changeMember(ctx, a.id, "bob", "join");
        await s.changeMember(ctx, b.id, "bob", "join");
        const original = await s.list(ctx);
        await s.changeMember(ctx, b.id, "alice", "reorder", null);
        const changed = await s.list(ctx);
        const own = (all: typeof changed, who: string) =>
            all.map((surface) => ({
                id: surface.id,
                ...surface.members.find((member) => member.userId === who)!,
            }));
        expect(own(changed, "bob")).toEqual(own(original, "bob"));
        expect(
            own(changed, "alice")
                .sort((x, y) => (x.orderKey < y.orderKey ? -1 : 1))
                .map((item) => item.id),
        ).toEqual([b.id, a.id]);
        await s.changeMember(ctx, a.id, "alice", "leave");
        expect((await s.list(ctx)).find((surface) => surface.id === a.id)!.members).toEqual(
            original
                .find((surface) => surface.id === a.id)!
                .members.filter((member) => member.userId === "bob"),
        );
        await expect(s.changeMember(ctx, a.id, "missing", "join")).rejects.toMatchObject({
            code: "not_found",
        });
        await expect(s.changeMember(ctx, a.id, null, "join")).rejects.toMatchObject({
            code: "not_found",
        });
    });

    it("rolls heads, immutable revisions, and durable notifications back with the caller", async () => {
        const { surfaces: s, db } = await fixture();
        const ctx = db.context;
        const surface = await s.create(ctx, { type: "todo", name: "Atomic" }, "alice");
        const actor = { userId: "alice", agentId: null };
        const first = await s.createTodo(ctx, surface.id, { text: "Original" }, actor);
        const pending = () =>
            agentDatabaseRows<{ id: string }>(
                db.database,
                sql`SELECT id FROM durable_function_calls ORDER BY id`,
            );
        const before = await pending();
        await expect(
            ctx.inTx(async (tx) => {
                const updated = await s.mutateTodo(
                    tx,
                    surface.id,
                    first.id,
                    first.version,
                    "update",
                    { text: "Temporary", status: "completed" },
                    actor,
                );
                expect(await s.getTodo(tx, surface.id, first.id)).toEqual(updated);
                expect((await s.versions(tx, surface.id, first.id)).versions).toHaveLength(2);
                await s.changeMember(tx, surface.id, "bob", "join");
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await s.getTodo(ctx, surface.id, first.id)).toEqual(first);
        expect(
            (await s.versions(ctx, surface.id, first.id)).versions.map((revision) => revision.todo),
        ).toEqual([first]);
        expect(await s.list(ctx)).toEqual([surface]);
        expect(await pending()).toEqual(before);
    });

    it("checks actual tool policies and revokes admin access at execution", async () => {
        const f = await fixture();
        const ctx = f.db.context;
        const ordinary = await f.hooks.tools!(ctx, {
            agent: { id: "ordinary" },
        } as AgentModuleScope);
        expect(ordinary.map((tool) => tool.name)).toEqual([
            "list_surfaces",
            "list_todos",
            "create_todo",
            "update_todo",
            "reorder_todo",
            "delete_todo",
            "list_todo_versions",
        ]);
        for (const tool of ordinary) {
            const read = tool.name.startsWith("list_");
            expect(tool.shouldReviewInAutoMode!({}, ctx)).toBe(!read);
            if (!read) {
                expect(tool.requiresAutoOrFullAccess).toBe(true);
                expect(tool.transactional).toBe(true);
            }
            expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
        }
        const tools = await f.hooks.tools!(ctx, { agent: { id: "admin" } } as AgentModuleScope);
        const create = tools.find((tool) => tool.name === "create_todo_surface")!;
        const add = tools.find((tool) => tool.name === "add_surface_user")!;
        expect(create.shouldReviewInAutoMode!({}, ctx)).toBe(true);
        expect(await create.shouldRunInFullAccessInAutoMode!({}, ctx)).toBe(false);
        expect(
            await create.shouldRunInFullAccessInAutoMode!(
                { imagePath: "/workspace/image.png" },
                ctx,
            ),
        ).toBe(false);
        f.compute.shouldReviewPath.mockResolvedValue(true);
        expect(
            await create.shouldRunInFullAccessInAutoMode!({ imagePath: "/outside/image.png" }, ctx),
        ).toBe(true);
        expect(
            create.describeAutoPermissionAction!({ imagePath: "/outside/image.png" }, ctx),
        ).toContain("outside-workspace");
        f.revoke();
        await expect(
            add.execute(ctx, { surfaceId: "surface1", userId: "alice" }, {} as never),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(create.execute(ctx, { name: "Denied" }, {} as never)).rejects.toMatchObject({
            code: "forbidden",
        });
    });
});
