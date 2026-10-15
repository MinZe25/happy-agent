import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

const malformedIds = [
    "todo",
    "document",
    "join",
    "leave",
    "reorder",
    "image",
    "",
    "a".repeat(23),
    "a".repeat(25),
    "A".repeat(24),
    "1".repeat(24),
    `${"a".repeat(24)}\n`,
];

describe("Surface IDs use generated CUID2 identities", () => {
    it("rejects malformed creation and anchor IDs while generated and caller-supplied CUID2s survive restart", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        for (const id of malformedIds) {
            await expect(
                gym.client.createSurface({ id, type: "todo", name: "Invalid" }),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        }
        expect((await gym.client.listSurfaces()).surfaces).toEqual([]);
        const generated = (await gym.client.createSurface({ type: "todo", name: "Generated" }))
            .surface;
        expect(generated.id).toHaveLength(24);
        expect(generated.id).toMatch(/^[a-z][a-z0-9]{23}$/);
        const supplied = (
            await gym.client.createSurface({
                id: "s12345678901234567890123",
                type: "todo",
                name: "Supplied",
            })
        ).surface;
        expect(
            (
                await gym.client.createSurface({
                    id: supplied.id,
                    type: "todo",
                    name: "Retry",
                })
            ).surface,
        ).toEqual(supplied);
        await expect(
            gym.client.reorderSurface(generated.id, { afterId: "todo" }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        const todo = (await gym.client.createTodo(generated.id, { text: "Durable" })).todo;
        await gym.client.leaveSurface(generated.id);
        await gym.client.joinSurface(generated.id);
        await gym.client.reorderSurface(generated.id, { afterId: null });
        await gym.restart();
        expect(
            (await gym.client.listSurfaces()).surfaces.map((surface) => surface.id).sort(),
        ).toEqual([generated.id, supplied.id].sort());
        expect((await gym.client.listTodos(generated.id)).todos).toEqual([todo]);
        expect(
            (await gym.client.getTodoVersion(generated.id, todo.id, todo.version)).revision.todo,
        ).toEqual(todo);
        expect(gym.errors).toEqual([]);
    });

    it("returns not found for every malformed Surface path before parsing its body or version", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        for (const id of malformedIds) {
            const encoded = encodeURIComponent(id);
            const paths = [
                ["POST", `/v0/surfaces/${encoded}/join`],
                ["POST", `/v0/surfaces/${encoded}/leave`],
                ["POST", `/v0/surfaces/${encoded}/reorder`],
                ["GET", `/v0/surfaces/${encoded}/image`],
                ["GET", `/v0/surfaces/todo/${encoded}`],
                ["POST", `/v0/surfaces/todo/${encoded}`],
                ["GET", `/v0/surfaces/todo/${encoded}/todo1`],
                ["PATCH", `/v0/surfaces/todo/${encoded}/todo1`],
                ["DELETE", `/v0/surfaces/todo/${encoded}/todo1`],
                ["POST", `/v0/surfaces/todo/${encoded}/todo1/reorder`],
                ["GET", `/v0/surfaces/todo/${encoded}/todo1/versions`],
                [
                    "GET",
                    `/v0/surfaces/todo/${encoded}/todo1/versions/01991f3a-5c1e-7000-8000-2f9a1b3c4d5e`,
                ],
            ] as const;
            for (const [method, path] of paths) {
                const response = await gym.http.request(method, path, { unexpected: true });
                expect({
                    method,
                    path,
                    status: response.status,
                    body: response.body,
                }).toMatchObject({
                    method,
                    path,
                    status: 404,
                    body: { code: "not_found" },
                });
            }
        }
        expect((await gym.client.listSurfaces()).surfaces).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
