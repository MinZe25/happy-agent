import {
    agentDatabaseRows,
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { SurfacesModule } from "../../sources/surfaces/index.js";
import { SurfacesPersistence } from "../../sources/surfaces/persistence/SurfacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const close: (() => void)[] = [];
afterEach(() => {
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

async function fixture(teamEnabled = true) {
    const durable = new DurableFunctionsModule();
    let adminActive = true;
    const bots = {
        forAgent: async (_ctx: unknown, id: string) =>
            id === "admin"
                ? { isAdmin: true, status: adminActive ? "active" : "archived" }
                : undefined,
    } as unknown as BotsModule;
    const team = {
        enabled: teamEnabled,
        getUser: async (_ctx: unknown, id: string) =>
            ["alice", "bob"].includes(id)
                ? { id, authentication: "jwt" }
                : id === "guest"
                  ? { id, authentication: "guest" }
                  : undefined,
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
        kv: new SurfacesPersistence(db.database).kv(),
        revoke: () => {
            adminActive = false;
        },
    };
}

describe("installation-owned Surface state", () => {
    it("discovers separator administration without granting filesystem access or ordinary-agent authority", async () => {
        const f = await fixture();
        const ctx = f.db.context;
        const ordinary = await f.hooks.tools!(ctx, {
            agent: { id: "ordinary" },
        } as AgentModuleScope);
        expect(ordinary.some((tool) => tool.name === "create_separator_surface")).toBe(false);
        const tools = await f.hooks.tools!(ctx, { agent: { id: "admin" } } as AgentModuleScope);
        const tool = tools.find((item) => item.name === "create_separator_surface")!;
        expect(tool).toMatchObject({
            defer: true,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            capabilities: [expect.stringContaining("separator")],
            searchKeywords: expect.arrayContaining(["create separator surface", "sidebar section"]),
        });
        expect(tool.shouldReviewInAutoMode!({}, ctx)).toBe(true);
        expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(tool.describeAutoPermissionAction!({ name: "Work" }, ctx)).toContain(
            "no filesystem access",
        );
        expect(Value.Check(tool.parameters, { name: "Work" })).toBe(false);
        expect(
            Value.Check(tool.parameters, {
                name: "Work",
                creatorUserId: "bob",
                imagePath: "/tmp/image.png",
            }),
        ).toBe(false);
        const call = { kv: f.kv.scoped("separator-call") } as never;
        const input = { name: "Work", creatorUserId: "bob" };
        const created = await tool.execute(ctx, input, call);
        expect(created).toMatchObject({
            type: "separator",
            image: null,
            creatorUserId: "bob",
            members: [{ userId: "bob" }],
        });
        expect(await tool.execute(ctx, input, call)).toEqual(created);
        expect(await f.surfaces.list(ctx)).toEqual([created]);
        f.revoke();
        await expect(tool.execute(ctx, input, call)).rejects.toMatchObject({ code: "forbidden" });
        expect(f.compute.resolve).not.toHaveBeenCalled();
    });

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
        const first = await s.createTodo(ctx, surface.id, { text: "Original" }, actor, "alice");
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
        for (const tool of tools) {
            if (await tool.shouldReviewInAutoMode!({}, ctx)) {
                expect(typeof tool.describeAutoPermissionAction, tool.name).toBe("function");
                expect(
                    tool.describeAutoPermissionAction!({}, ctx)?.length,
                    tool.name,
                ).toBeGreaterThan(0);
            }
        }
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
            add.execute(
                ctx,
                { surfaceId: "s12345678901234567890123", userId: "alice" },
                {} as never,
            ),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(create.execute(ctx, { name: "Denied" }, {} as never)).rejects.toMatchObject({
            code: "forbidden",
        });
    });

    it("attributes explicit tool users independently of the executing person's audit identity", async () => {
        const f = await fixture();
        const ctx = f.db.context;
        const agentKv = f.kv.scoped("agent");
        await agentKv.write(ctx, "owner", "alice");
        const tools = await f.hooks.tools!(ctx, {
            agent: { id: "admin" },
            kv: agentKv,
        } as AgentModuleScope);
        const createSurface = tools.find((tool) => tool.name === "create_todo_surface")!;
        const createTodo = tools.find((tool) => tool.name === "create_todo")!;
        expect(Value.Check(createSurface.parameters, { name: "Missing" })).toBe(false);
        expect(
            Value.Check(createTodo.parameters, {
                surfaceId: "s12345678901234567890123",
                text: "Missing",
            }),
        ).toBe(false);
        expect(Value.Check(createSurface.parameters, { name: "Valid", creatorUserId: null })).toBe(
            true,
        );
        expect(
            Value.Check(createTodo.parameters, {
                surfaceId: "s12345678901234567890123",
                text: "Valid",
                authorUserId: null,
            }),
        ).toBe(true);

        await createSurface.execute(ctx, { name: "Bob's list", creatorUserId: "bob" }, {
            kv: f.kv.scoped("surface-call"),
        } as never);
        const [surface] = await f.surfaces.list(ctx);
        expect(surface).toMatchObject({ creatorUserId: "bob", members: [{ userId: "bob" }] });
        await createTodo.execute(
            ctx,
            { surfaceId: surface!.id, text: "Bob's todo", authorUserId: "bob" },
            {
                kv: f.kv.scoped("todo-call"),
            } as never,
        );
        await createTodo.execute(
            ctx,
            { surfaceId: surface!.id, text: "Unattributed", authorUserId: null },
            {
                kv: f.kv.scoped("null-todo-call"),
            } as never,
        );
        const [unattributed, todo] = await f.surfaces.listTodos(ctx, surface!.id);
        expect(todo!.authorUserId).toBe("bob");
        expect(unattributed!.authorUserId).toBeNull();
        for (const item of [todo!, unattributed!]) {
            expect(
                (await f.surfaces.versions(ctx, surface!.id, item.id)).versions[0],
            ).toMatchObject({
                todo: item,
                actor: { userId: "alice", agentId: "admin" },
                source: "tool",
            });
        }
        await createSurface.execute(ctx, { name: "Unattributed list", creatorUserId: null }, {
            kv: f.kv.scoped("null-surface-call"),
        } as never);
        expect(
            (await f.surfaces.list(ctx)).find((item) => item.name === "Unattributed list"),
        ).toMatchObject({ creatorUserId: null, members: [] });
    });

    it("requires explicit null attribution in standalone operations", async () => {
        const { surfaces: s, db } = await fixture(false);
        const ctx = db.context;
        const surface = await s.create(ctx, { type: "todo", name: "Local" }, null);
        expect(surface).toMatchObject({ creatorUserId: null, members: [{ userId: null }] });
        const actor = { userId: null, agentId: null };
        for (const invalid of [undefined, "", "workos_user_123", "alice"]) {
            await expect(
                s.create(ctx, { type: "todo", name: "Invalid" }, invalid as never),
            ).rejects.toMatchObject({ code: "invalid_request" });
            await expect(
                s.createTodo(ctx, surface.id, { text: "Invalid" }, actor, invalid as never),
            ).rejects.toMatchObject({ code: "invalid_request" });
        }
        expect(await s.list(ctx)).toEqual([surface]);
        expect(await s.listTodos(ctx, surface.id)).toEqual([]);
        expect(
            (await s.createTodo(ctx, surface.id, { text: "Local" }, actor, null)).authorUserId,
        ).toBeNull();
    });

    it.each(["missing", "guest"])(
        "rejects %s attribution without creating records",
        async (userId) => {
            const { surfaces: s, db } = await fixture();
            const ctx = db.context;
            const surface = await s.create(ctx, { type: "todo", name: "Valid" }, "alice");
            await expect(
                s.create(ctx, { type: "todo", name: "Rejected" }, userId),
            ).rejects.toMatchObject({ code: "not_found" });
            await expect(
                s.createTodo(
                    ctx,
                    surface.id,
                    { text: "Rejected" },
                    { userId: "alice", agentId: "admin" },
                    userId,
                ),
            ).rejects.toMatchObject({ code: "not_found" });
            expect(await s.list(ctx)).toEqual([surface]);
            expect(await s.listTodos(ctx, surface.id)).toEqual([]);
        },
    );

    it("keeps author and creator immutable across edits, history, joins, and creation retries", async () => {
        const { surfaces: s, db } = await fixture();
        const ctx = db.context;
        const surface = await s.create(ctx, { type: "todo", name: "Alice" }, "alice");
        const actor = { userId: "bob", agentId: "admin" };
        const todo = await s.createTodo(ctx, surface.id, { text: "Original" }, actor, "alice");
        const changed = await s.mutateTodo(
            ctx,
            surface.id,
            todo.id,
            todo.version,
            "update",
            { text: "Edited", status: "completed" },
            actor,
        );
        expect(changed.authorUserId).toBe("alice");
        await expect(
            s.mutateTodo(
                ctx,
                surface.id,
                todo.id,
                changed.version,
                "update",
                {
                    text: "Forbidden",
                    authorUserId: "bob",
                } as never,
                actor,
            ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(
            await s.createTodo(ctx, surface.id, { id: todo.id, text: "Retry" }, actor, "bob"),
        ).toEqual(changed);
        const left = await s.changeMember(ctx, surface.id, "alice", "leave");
        expect(left.creatorUserId).toBe("alice");
        expect(left.members).toEqual([]);
        expect(await s.create(ctx, { id: surface.id, type: "todo", name: "Retry" }, "bob")).toEqual(
            left,
        );
        expect(
            (await s.versions(ctx, surface.id, todo.id)).versions.map(
                (revision) => revision.todo.authorUserId,
            ),
        ).toEqual(["alice", "alice"]);
    });

    it("reads older snapshots as unattributed without inferring from actors or rewriting history", async () => {
        const { surfaces: s, db, kv } = await fixture();
        const ctx = db.context;
        const surface = await s.create(
            ctx,
            { id: "s12345678901234567890123", type: "todo", name: "Old" },
            "alice",
        );
        const actor = { userId: "alice", agentId: "admin" };
        const todo = await s.createTodo(
            ctx,
            surface.id,
            { id: "oldtodo", text: "Old todo" },
            actor,
            "alice",
        );
        const { creatorUserId: _creator, ...oldSurface } = surface;
        const { authorUserId: _author, ...oldTodo } = todo;
        const oldRevision = { todo: oldTodo, actor, source: "tool" };
        const revisionKey = `revision.${surface.id}.${todo.id}.${todo.version}`;
        await kv.write(ctx, `surface.${surface.id}`, oldSurface);
        await kv.write(ctx, `todo.${surface.id}.${todo.id}`, oldTodo);
        await kv.write(ctx, revisionKey, oldRevision);
        const expectedTodo = { ...oldTodo, authorUserId: null };
        const expectedSurface = { ...oldSurface, creatorUserId: null };
        expect(await s.list(ctx)).toEqual([expectedSurface]);
        expect(await s.listTodos(ctx, surface.id)).toEqual([expectedTodo]);
        expect(await s.getTodo(ctx, surface.id, todo.id)).toEqual(expectedTodo);
        expect(await s.create(ctx, { id: surface.id, type: "todo", name: "Retry" }, "bob")).toEqual(
            expectedSurface,
        );
        expect(
            await s.createTodo(ctx, surface.id, { id: todo.id, text: "Retry" }, actor, "bob"),
        ).toEqual(expectedTodo);
        expect(await s.getVersion(ctx, surface.id, todo.id, todo.version)).toEqual({
            ...oldRevision,
            todo: expectedTodo,
        });
        expect((await s.versions(ctx, surface.id, todo.id)).versions).toEqual([
            { ...oldRevision, todo: expectedTodo },
        ]);
        expect(await kv.read(ctx, revisionKey)).toEqual(oldRevision);
        expect(await kv.read(ctx, `todo.${surface.id}.${todo.id}`)).toEqual(oldTodo);
        const edited = await s.mutateTodo(
            ctx,
            surface.id,
            todo.id,
            todo.version,
            "update",
            { text: "Edited" },
            actor,
        );
        expect(edited.authorUserId).toBeNull();
        expect(await kv.read(ctx, revisionKey)).toEqual(oldRevision);
        expect(
            (await s.versions(ctx, surface.id, todo.id)).versions.map(
                (revision) => revision.todo.authorUserId,
            ),
        ).toEqual([null, null]);
    });
});
