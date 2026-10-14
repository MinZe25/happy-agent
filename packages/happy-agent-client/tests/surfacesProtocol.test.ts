import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { desktopBootstrapResponseSchema } from "../sources/protocol/bootstrap.js";
import {
    surfaceCreatedPayloadSchema,
    surfaceUpdatedPayloadSchema,
    todoCreatedPayloadSchema,
    todoUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import {
    createSurfaceRequestSchema,
    createTodoRequestSchema,
    surfaceListResponseSchema,
    surfaceMemberSchema,
    surfaceOrderKeySchema,
    surfaceResponseSchema,
    surfaceSchema,
    todoRevisionSchema,
    todoSchema,
    updateTodoRequestSchema,
    type Surface,
    type SurfaceMember,
    type Todo,
    type TodoRevision,
} from "../sources/protocol/surfaces.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const now = 1_755_400_000_000;
const member: SurfaceMember = {
    userId: "user1",
    orderKey: "5",
    joinedAt: now,
};
const surface: Surface = {
    creatorUserId: "user1",
    id: "surface1",
    type: "todo",
    image: null,
    name: "Todo",
    members: [member],
    updatedAt: now,
    version,
};
const todo: Todo = {
    authorUserId: "user2",
    id: "todo1",
    surfaceId: "surface1",
    text: "Pick up groceries",
    status: "active",
    orderKey: "5",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
    version,
};
const revision: TodoRevision = {
    todo,
    actor: { userId: "user1", agentId: null },
    source: "api",
};

describe("Surface and Todo protocol", () => {
    it("validates nullable user attribution while accepting older responses without it", () => {
        const { creatorUserId: _creator, ...olderSurface } = surface;
        const { authorUserId: _author, ...olderTodo } = todo;
        expect(Value.Check(surfaceSchema, olderSurface)).toBe(true);
        expect(Value.Check(todoSchema, olderTodo)).toBe(true);
        expect(Value.Check(todoRevisionSchema, { ...revision, todo: olderTodo })).toBe(true);
        expect(surfaceSchema.required).not.toContain("creatorUserId");
        for (const variant of todoSchema.anyOf) {
            expect(variant.required).not.toContain("authorUserId");
        }
        for (const userId of [null, "user1"]) {
            expect(Value.Check(surfaceSchema, { ...surface, creatorUserId: userId })).toBe(true);
            for (const state of [
                todo,
                { ...todo, status: "completed", orderKey: null, completedAt: now },
                { ...todo, status: "deleted", orderKey: null, deletedAt: now },
            ]) {
                const snapshot = { ...state, authorUserId: userId };
                expect(Value.Check(todoSchema, snapshot)).toBe(true);
                expect(Value.Check(todoRevisionSchema, { ...revision, todo: snapshot })).toBe(true);
            }
        }
        for (const invalid of ["", "workos_user_123", 42, {}, []]) {
            expect(Value.Check(surfaceSchema, { ...surface, creatorUserId: invalid })).toBe(false);
            expect(Value.Check(todoSchema, { ...todo, authorUserId: invalid })).toBe(false);
        }
    });

    it("carries immutable attribution in creation events and rejects HTTP attribution inputs", () => {
        expect(Value.Check(surfaceCreatedPayloadSchema, { surface })).toBe(true);
        expect(Value.Check(todoCreatedPayloadSchema, { todo })).toBe(true);
        expect(revision.todo.authorUserId).not.toBe(revision.actor.userId);
        expect(
            Value.Check(createSurfaceRequestSchema, {
                name: "Shared list",
                type: "todo",
                creatorUserId: "user1",
            }),
        ).toBe(false);
        for (const authorUserId of [null, "user1"]) {
            expect(Value.Check(createTodoRequestSchema, { text: "New", authorUserId })).toBe(false);
            expect(Value.Check(updateTodoRequestSchema, { text: "Edit", authorUserId })).toBe(
                false,
            );
        }
    });

    it("nests member records and uses one empty joined-user representation", () => {
        expect(Value.Check(surfaceSchema, surface)).toBe(true);
        expect(Value.Check(surfaceSchema, { ...surface, members: [] })).toBe(true);
        expect(Value.Check(surfaceSchema, { ...surface, members: [null] })).toBe(false);
        expect(Value.Check(surfaceSchema, { ...surface, members: null })).toBe(false);
        expect(Value.Check(surfaceMemberSchema, { ...member, userId: null })).toBe(true);
        expect(Value.Check(surfaceResponseSchema, { surface })).toBe(true);
        expect(
            Value.Check(surfaceListResponseSchema, { surfaces: [surface], cursor: version }),
        ).toBe(true);
        expect(Object.keys(surfaceListResponseSchema.properties).sort()).toEqual([
            "cursor",
            "surfaces",
        ]);
        expect(Value.Check(surfaceSchema, { ...surface, id: "calendar", type: "calendar" })).toBe(
            true,
        );
        expect(Value.Check(surfaceSchema, { ...surface, id: "Todo/List" })).toBe(false);
    });

    it("rejects ranks on completed/deleted todos and invalid lifecycle combinations", () => {
        expect(Value.Check(todoSchema, todo)).toBe(true);
        const completed = { ...todo, status: "completed", orderKey: null, completedAt: now };
        const deleted = { ...completed, status: "deleted", deletedAt: now };
        expect(Value.Check(todoSchema, completed)).toBe(true);
        expect(Value.Check(todoSchema, deleted)).toBe(true);
        expect(Value.Check(todoSchema, { ...deleted, completedAt: null })).toBe(true);
        expect(Value.Check(todoSchema, { ...completed, orderKey: "5" })).toBe(false);
        expect(Value.Check(todoSchema, { ...deleted, orderKey: "5" })).toBe(false);
        expect(Value.Check(todoSchema, { ...todo, completedAt: now })).toBe(false);
        expect(Value.Check(todoSchema, { ...todo, deletedAt: now })).toBe(false);
        for (const key of ["5", "05", "9995"])
            expect(Value.Check(surfaceOrderKeySchema, key)).toBe(true);
        for (const key of ["", "0", "50", "a0"])
            expect(Value.Check(surfaceOrderKeySchema, key)).toBe(false);
    });

    it("requires actual edits, bounds text, and prevents callers supplying lifecycle or audit fields", () => {
        for (const text of ["Buy milk", "Two\nlines\twith a tab", "🙂", "a".repeat(10_000)]) {
            expect(Value.Check(createTodoRequestSchema, { text })).toBe(true);
        }
        for (const text of ["", " \n\t ", "a\rb", "a\x00b", "a".repeat(10_001)]) {
            expect(Value.Check(createTodoRequestSchema, { text })).toBe(false);
        }
        expect(Value.Check(updateTodoRequestSchema, { text: "Changed" })).toBe(true);
        expect(Value.Check(updateTodoRequestSchema, { status: "active" })).toBe(true);
        expect(Value.Check(updateTodoRequestSchema, { text: "Changed", status: "completed" })).toBe(
            true,
        );
        expect(Value.Check(updateTodoRequestSchema, {})).toBe(false);
        expect(Value.Check(updateTodoRequestSchema, { mutationId: "m" })).toBe(false);
        expect(Value.Check(updateTodoRequestSchema, { text: "Changed", orderKey: "5" })).toBe(
            false,
        );
        expect(
            Value.Check(createTodoRequestSchema, { text: "Create", actor: { userId: "user2" } }),
        ).toBe(false);
        expect(Value.Check(todoRevisionSchema, revision)).toBe(true);
        expect(
            Value.Check(todoRevisionSchema, {
                ...revision,
                actor: { userId: null, agentId: "agent1" },
                source: "tool",
            }),
        ).toBe(true);
        expect(Value.Check(todoRevisionSchema, { ...revision, actor: undefined })).toBe(false);
    });

    it("keeps Surface bootstrap fields optional for older compatible daemons", () => {
        expect(desktopBootstrapResponseSchema.required).not.toContain("surfaces");
        expect(Value.Check(desktopBootstrapResponseSchema.properties.surfaces, [surface])).toBe(
            true,
        );
        expect(desktopBootstrapResponseSchema.properties).not.toHaveProperty("surfaceMembers");
    });

    it("exposes nested member replacements and todo revision changes through shared events", () => {
        const events: HappyAgentEvent[] = [
            {
                cursor: nextVersion,
                occurredAt: now,
                type: "surface.updated",
                payload: {
                    surfaceId: "surface1",
                    previousVersion: version,
                    version: nextVersion,
                    changes: { members: [], updatedAt: now },
                },
            },
            { cursor: version, occurredAt: now, type: "todo.created", payload: { todo } },
            {
                cursor: nextVersion,
                occurredAt: now,
                type: "todo.updated",
                payload: {
                    surfaceId: "surface1",
                    todoId: todo.id,
                    previousVersion: version,
                    version: nextVersion,
                    changes: { status: "deleted", deletedAt: now, orderKey: null, updatedAt: now },
                },
            },
        ];
        for (const [index, schema] of [
            surfaceUpdatedPayloadSchema,
            todoCreatedPayloadSchema,
            todoUpdatedPayloadSchema,
        ].entries()) {
            expect(Value.Check(schema, events[index]?.payload)).toBe(true);
        }
        expect(
            Value.Check(todoUpdatedPayloadSchema, {
                surfaceId: "surface1",
                todoId: todo.id,
                previousVersion: version,
                version: nextVersion,
                changes: { text: "Changed" },
            }),
        ).toBe(false);
    });

    it("uses the agreed Surface prefix, encodes identities, and sends current version guards", async () => {
        const requests: { method: string; url: string; body: unknown; ifMatch: string | null }[] =
            [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                method: init?.method ?? "GET",
                url: input.toString(),
                body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                ifMatch: new Headers(init?.headers).get("if-match"),
            });
            return new Response(JSON.stringify({ todo, surface, member }), { status: 200 });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        await client.listSurfaces();
        await client.joinSurface("surface1", { mutationId: "join" });
        await client.leaveSurface("surface1");
        await client.reorderSurface("surface1", { afterId: null });
        await client.listTodos("surface1");
        await client.listTodos("surface1", { scope: "completed" });
        await client.createTodo("surface1", { id: "todo1", text: todo.text });
        await client.getTodo("surface1", "todo/1");
        await client.updateTodo("surface1", "todo1", { status: "completed" }, { ifMatch: version });
        await client.reorderTodo("surface1", "todo1", { afterId: null }, { ifMatch: nextVersion });
        await client.deleteTodo("surface1", "todo1", { ifMatch: version, mutationId: "delete" });
        await client.updateTodo(
            "surface1",
            "todo1",
            { status: "active" },
            { ifMatch: nextVersion },
        );
        await client.listTodoVersions("surface1", "todo1", { afterVersion: version, limit: 2 });
        await client.getTodoVersion("surface1", "todo1", "version/1");

        expect(requests).toEqual([
            { method: "GET", url: "http://agent.local/v0/surfaces", body: null, ifMatch: null },
            {
                method: "POST",
                url: "http://agent.local/v0/surfaces/surface1/join",
                body: { mutationId: "join" },
                ifMatch: null,
            },
            {
                method: "POST",
                url: "http://agent.local/v0/surfaces/surface1/leave",
                body: {},
                ifMatch: null,
            },
            {
                method: "POST",
                url: "http://agent.local/v0/surfaces/surface1/reorder",
                body: { afterId: null },
                ifMatch: null,
            },
            {
                method: "GET",
                url: "http://agent.local/v0/surfaces/todo/surface1",
                body: null,
                ifMatch: null,
            },
            {
                method: "GET",
                url: "http://agent.local/v0/surfaces/todo/surface1?scope=completed",
                body: null,
                ifMatch: null,
            },
            {
                method: "POST",
                url: "http://agent.local/v0/surfaces/todo/surface1",
                body: { id: "todo1", text: todo.text },
                ifMatch: null,
            },
            {
                method: "GET",
                url: "http://agent.local/v0/surfaces/todo/surface1/todo%2F1",
                body: null,
                ifMatch: null,
            },
            {
                method: "PATCH",
                url: "http://agent.local/v0/surfaces/todo/surface1/todo1",
                body: { status: "completed" },
                ifMatch: version,
            },
            {
                method: "POST",
                url: "http://agent.local/v0/surfaces/todo/surface1/todo1/reorder",
                body: { afterId: null },
                ifMatch: nextVersion,
            },
            {
                method: "DELETE",
                url: "http://agent.local/v0/surfaces/todo/surface1/todo1",
                body: { mutationId: "delete" },
                ifMatch: version,
            },
            {
                method: "PATCH",
                url: "http://agent.local/v0/surfaces/todo/surface1/todo1",
                body: { status: "active" },
                ifMatch: nextVersion,
            },
            {
                method: "GET",
                url: `http://agent.local/v0/surfaces/todo/surface1/todo1/versions?afterVersion=${version}&limit=2`,
                body: null,
                ifMatch: null,
            },
            {
                method: "GET",
                url: "http://agent.local/v0/surfaces/todo/surface1/todo1/versions/version%2F1",
                body: null,
                ifMatch: null,
            },
        ]);
    });

    it("preserves immutable revision responses and exposes current todo on conflicts without retry", async () => {
        let calls = 0;
        const fetch: typeof globalThis.fetch = async (input, init) => {
            calls += 1;
            if (init?.method === "PATCH")
                return new Response(
                    JSON.stringify({
                        error: "The todo has changed.",
                        code: "conflict",
                        currentVersion: nextVersion,
                        todo: { ...todo, version: nextVersion },
                    }),
                    { status: 409 },
                );
            return new Response(
                JSON.stringify(
                    input.toString().endsWith("/versions")
                        ? { versions: [revision], nextAfterVersion: null }
                        : { revision },
                ),
                { status: 200 },
            );
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        await expect(client.listTodoVersions("surface1", todo.id)).resolves.toEqual({
            versions: [revision],
            nextAfterVersion: null,
        });
        await expect(client.getTodoVersion("surface1", todo.id, version)).resolves.toEqual({
            revision,
        });
        const error = await client
            .updateTodo(
                "surface1",
                todo.id,
                { text: revision.todo.text, status: revision.todo.status },
                { ifMatch: version },
            )
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: nextVersion, todo: { ...todo, version: nextVersion } },
        });
        expect(calls).toBe(3);
    });
});
