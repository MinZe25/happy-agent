import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("separator Surfaces are contentless sidebar items", () => {
    it("attributes team creation and keeps each person's sidebar independent across restart", async () => {
        const { gym, alice, bob, aliceId, bobId } = await surfaceTeamClients();
        running.push(gym);
        const separator = (await alice.createSurface({ type: "separator", name: "Team" })).surface;
        expect(separator).toMatchObject({ creatorUserId: aliceId, members: [{ userId: aliceId }] });
        const joined = (await bob.joinSurface(separator.id)).surface;
        expect(joined.members.map((member) => member.userId).sort()).toEqual(
            [aliceId, bobId].sort(),
        );
        const left = (await alice.leaveSurface(separator.id)).surface;
        expect(left).toMatchObject({ creatorUserId: aliceId, members: [{ userId: bobId }] });
        const other = (await alice.createSurface({ type: "todo", name: "Unrelated" })).surface;
        expect(other.members).toHaveLength(1);
        expect((await bob.listSurfaces()).surfaces).toContainEqual(left);
        await gym.restart();
        expect((await alice.getDesktopBootstrap()).surfaces).toContainEqual(left);
        expect((await bob.listSurfaces()).surfaces).toContainEqual(left);
        expect(gym.errors).toEqual([]);
    });

    it("preserves independent membership and order without accepting content or images", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const list = (await client.createSurface({ type: "todo", name: "Inbox" })).surface;
        const separator = (
            await client.createSurface({
                type: "separator",
                name: "Work",
                mutationId: "separator-create",
            })
        ).surface;
        expect(separator).toMatchObject({
            id: expect.stringMatching(/^[a-z][a-z0-9]{23}$/),
            type: "separator",
            name: "Work",
            image: null,
            creatorUserId: null,
            members: [{ userId: null }],
        });
        expect(separator.members[0]!.orderKey > list.members[0]!.orderKey).toBe(true);
        expect(
            (await client.createSurface({ type: "separator", id: separator.id, name: "Retry" }))
                .surface,
        ).toEqual(separator);
        for (const image of [null, { data: "bm90LWltYWdl" }]) {
            await expect(
                client.createSurface({ type: "separator", name: "Invalid", image } as never),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        }
        await expect(client.getSurfaceImage(separator.id)).rejects.toMatchObject({ status: 404 });
        await expect(client.listTodos(separator.id)).rejects.toMatchObject({ status: 404 });
        await expect(client.createTodo(separator.id, { text: "No content" })).rejects.toMatchObject(
            { status: 404 },
        );
        const todo = (await client.createTodo(list.id, { text: "Unrelated todo" })).todo;
        await expect(client.getTodo(separator.id, todo.id)).rejects.toMatchObject({ status: 404 });
        await expect(
            client.updateTodo(separator.id, todo.id, { text: "No" }, { ifMatch: todo.version }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(client.listTodoVersions(separator.id, todo.id)).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            client.getTodoVersion(separator.id, todo.id, todo.version),
        ).rejects.toMatchObject({ status: 404 });
        const moved = (await client.reorderSurface(separator.id, { afterId: null })).surface;
        expect(moved.members[0]!.orderKey < list.members[0]!.orderKey).toBe(true);
        expect((await client.leaveSurface(separator.id)).surface.members).toEqual([]);
        const joined = (await client.joinSurface(separator.id, { mutationId: "separator-join" }))
            .surface;
        expect(joined.members[0]!.orderKey > list.members[0]!.orderKey).toBe(true);
        await gym.waitForEvent(
            (event) =>
                event.type === "surface.updated" && event.payload.mutationId === "separator-join",
            "separator membership notification",
        );
        const events = (await client.getEvents({ limit: 1000 })).events;
        expect(
            events.filter(
                (event) =>
                    event.type === "surface.created" && event.payload.surface.id === separator.id,
            ),
        ).toMatchObject([{ payload: { surface: separator, mutationId: "separator-create" } }]);
        expect((await client.getTodo(list.id, todo.id)).todo).toEqual(todo);
        expect((await client.listSurfaces()).surfaces).toHaveLength(2);
        await gym.restart();
        expect((await gym.client.getDesktopBootstrap()).surfaces).toContainEqual(joined);
        await expect(gym.client.listTodos(separator.id)).rejects.toMatchObject({ status: 404 });
        expect(gym.errors).toEqual([]);
    });

    it.each(["read_only", "workspace_write", "auto-deny", "auto-allow"] as const)(
        "enforces %s on the real separator administration tool",
        async (mode) => {
            const permissionMode = mode.startsWith("auto")
                ? ("auto" as const)
                : (mode as "read_only" | "workspace_write");
            let adminId = "";
            let called = false;
            const reviews: string[] = [];
            const gym = await createAgentGym({
                permissionMode,
                inference(request) {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "<title>Separator</title>" }] };
                    if (request.sessionId !== adminId) {
                        reviews.push(JSON.stringify(request.messages));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><outcome>${mode === "auto-allow" ? "allow" : "deny"}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    if (called) return { content: [{ type: "text", text: "Finished." }] };
                    called = true;
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "create_separator_surface",
                                arguments: { name: "Work", creatorUserId: null },
                            },
                        ],
                    };
                },
            });
            running.push(gym);
            adminId = (await gym.client.createBot({ name: "Administrator", isAdmin: true })).bot
                .agent.id;
            await gym.send("Create a shared separator Surface named Work.", {
                sessionId: adminId,
                permissionMode,
            });
            const surfaces = (await gym.client.listSurfaces()).surfaces;
            expect(surfaces).toHaveLength(mode === "auto-allow" ? 1 : 0);
            expect(reviews).toHaveLength(mode.startsWith("auto") ? 1 : 0);
            if (reviews.length > 0) {
                expect(reviews[0]).toContain("Create a shared separator Surface named Work.");
                expect(reviews[0]).toContain("create_separator_surface");
                expect(reviews[0]).toContain("shared data write");
            }
            if (mode === "auto-allow") {
                expect(surfaces[0]).toMatchObject({ type: "separator", image: null });
                await gym.restart();
                expect((await gym.client.listSurfaces()).surfaces).toEqual(surfaces);
            }
            expect(gym.errors).toEqual([]);
            expect(gym.inference.unscripted).toEqual([]);
        },
    );
});
