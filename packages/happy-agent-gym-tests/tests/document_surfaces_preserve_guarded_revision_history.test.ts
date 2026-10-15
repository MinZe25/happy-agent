import { HappyAgentClient } from "@slopus/happy-agent-client";
import { createAgentGym, createUnixSocketFetch, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("document Surfaces preserve guarded revision history", () => {
    it("rejects invalid text, stale races, wrong types, and history cursors without changing state", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const surface = (await client.createSurface({ type: "document", name: "Bounds" })).surface;
        const initial = (await client.getSurfaceDocument(surface.id)).document;
        expect(initial.text).toBe("");
        const other = (await client.createSurface({ type: "document", name: "Other" })).surface;
        const otherDocument = (await client.getSurfaceDocument(other.id)).document;
        const list = (await client.createSurface({ type: "todo", name: "List" })).surface;
        for (const surfaceId of [list.id, "todo", "s00000000000000000000000"]) {
            await expect(client.getSurfaceDocument(surfaceId)).rejects.toMatchObject({
                status: 404,
            });
            await expect(client.listSurfaceDocumentVersions(surfaceId)).rejects.toMatchObject({
                status: 404,
            });
            await expect(
                client.updateSurfaceDocument(
                    surfaceId,
                    { text: "Rejected" },
                    { ifMatch: initial.version },
                ),
            ).rejects.toMatchObject({ status: 404 });
        }
        await expect(client.listTodos(surface.id)).rejects.toMatchObject({ status: 404 });
        for (const text of ["NUL\0", "a".repeat(262_145), "🙂".repeat(131_073), 1, null])
            await expect(
                client.updateSurfaceDocument(surface.id, { text } as never, {
                    ifMatch: initial.version,
                }),
            ).rejects.toMatchObject({ status: 400 });
        for (const extra of [
            { authorUserId: null },
            { lastEditorUserId: null },
            { actor: {} },
            { patch: [] },
        ])
            await expect(
                client.updateSurfaceDocument(
                    surface.id,
                    { text: "Rejected", ...extra },
                    { ifMatch: initial.version },
                ),
            ).rejects.toMatchObject({ status: 400 });
        for (const ifMatch of ["", "bad-version"])
            await expect(
                client.updateSurfaceDocument(surface.id, { text: "Rejected" }, { ifMatch }),
            ).rejects.toMatchObject({ status: 400 });
        for (const limit of [0, 201, 1.5, Number.NaN])
            await expect(
                client.listSurfaceDocumentVersions(surface.id, { limit }),
            ).rejects.toMatchObject({ status: 400 });
        await expect(
            client.listSurfaceDocumentVersions(surface.id, { afterVersion: "bad-version" }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            client.listSurfaceDocumentVersions(surface.id, { afterVersion: otherDocument.version }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            client.getSurfaceDocumentVersion(surface.id, otherDocument.version),
        ).rejects.toMatchObject({ status: 404 });
        expect((await client.getSurfaceDocument(surface.id)).document).toEqual(initial);
        expect((await client.listSurfaceDocumentVersions(surface.id)).versions).toHaveLength(1);
        const outcomes = await Promise.allSettled([
            client.updateSurfaceDocument(
                surface.id,
                { text: "First", mutationId: "race-a" },
                { ifMatch: initial.version },
            ),
            client.updateSurfaceDocument(
                surface.id,
                { text: "Second", mutationId: "race-b" },
                { ifMatch: initial.version },
            ),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
            reason: { status: 409 },
        });
        let current = (await client.getSurfaceDocument(surface.id)).document;
        expect((await client.listSurfaceDocumentVersions(surface.id)).versions).toHaveLength(2);
        for (const text of ["🙂".repeat(131_072), "\u0001".repeat(262_144)]) {
            current = (
                await client.updateSurfaceDocument(
                    surface.id,
                    { text },
                    { ifMatch: current.version },
                )
            ).document;
            expect(current.text).toBe(text);
        }
        await gym.waitForEvent(
            (event) =>
                event.type === "surface.document.updated" &&
                event.payload.version === current.version,
            "bounded document update",
        );
        expect(
            (await client.getEvents({ limit: 1000 })).events.filter(
                (event) => event.type === "surface.document.updated",
            ),
        ).toHaveLength(3);
        expect(gym.errors).toEqual([]);
    });

    it("finds a committed save by immutable mutation ID after its response was lost and another edit landed", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const surface = (await client.createSurface({ type: "document", name: "Recovery" }))
            .surface;
        const base = (await client.getSurfaceDocument(surface.id)).document;
        const socketFetch = createUnixSocketFetch(gym.socketPath);
        let writes = 0;
        const interrupted = new HappyAgentClient({
            endpoint: client.endpoint,
            token: gym.token,
            fetch: async (input, init) => {
                const response = await socketFetch(input, init);
                if (init?.method === "PUT") {
                    writes += 1;
                    await response.body?.cancel();
                    throw new Error("The save response was lost.");
                }
                return response;
            },
        });
        await expect(
            interrupted.updateSurfaceDocument(
                surface.id,
                { text: "My saved text", mutationId: "uncertain-save" },
                { ifMatch: base.version },
            ),
        ).rejects.toThrow("The save response was lost.");
        const committed = (await client.getSurfaceDocument(surface.id)).document;
        await client.updateSurfaceDocument(
            surface.id,
            { text: "Collaborator edit", mutationId: "later" },
            { ifMatch: committed.version },
        );
        const history = await client.listSurfaceDocumentVersions(surface.id, {
            afterVersion: base.version,
            limit: 1,
        });
        expect(history.versions).toMatchObject([
            { version: committed.version, mutationId: "uncertain-save" },
        ]);
        expect(
            (await client.getSurfaceDocumentVersion(surface.id, history.versions[0]!.version))
                .revision.document.text,
        ).toBe("My saved text");
        expect(writes).toBe(1);
        await gym.restart();
        expect(
            (await gym.client.getSurfaceDocumentVersion(surface.id, committed.version)).revision
                .mutationId,
        ).toBe("uncertain-save");
    });

    it("keeps team authorship separate from the current API or tool editor", async () => {
        let nextTool: { name: string; arguments: unknown } | undefined;
        const { gym, alice, bob, aliceId, bobId } = await surfaceTeamClients({
            permissionMode: "full_access",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Document</title>" }] };
                if (nextTool !== undefined) {
                    const tool = nextTool;
                    nextTool = undefined;
                    return { content: [{ type: "tool_call", ...tool }] };
                }
                return { content: [{ type: "text", text: "Finished." }] };
            },
        });
        running.push(gym);
        const surface = (await alice.createSurface({ type: "document", name: "Team document" }))
            .surface;
        const initial = (await alice.getSurfaceDocument(surface.id)).document;
        expect(initial).toMatchObject({ authorUserId: aliceId, lastEditorUserId: aliceId });
        const edited = (
            await bob.updateSurfaceDocument(
                surface.id,
                { text: "Bob's edit" },
                { ifMatch: initial.version },
            )
        ).document;
        expect(edited).toMatchObject({ authorUserId: aliceId, lastEditorUserId: bobId });
        expect(
            (await bob.getSurfaceDocumentVersion(surface.id, edited.version)).revision,
        ).toMatchObject({
            actor: { userId: bobId, agentId: null },
            source: "api",
            mutationId: null,
        });
        const admin = (await alice.createBot({ name: "Administrator", isAdmin: true })).bot;
        nextTool = {
            name: "create_document_surface",
            arguments: { name: "For Bob", creatorUserId: bobId, text: "# Tool document" },
        };
        await gym.send("Create the document For Bob, attributed to Bob.", {
            sessionId: admin.agent.id,
            permissionMode: "full_access",
        });
        const created = (await alice.listSurfaces()).surfaces.find(
            (item) => item.name === "For Bob",
        )!;
        expect(created).toMatchObject({ creatorUserId: bobId, members: [{ userId: bobId }] });
        const document = (await bob.getSurfaceDocument(created.id)).document;
        expect(document).toMatchObject({
            authorUserId: bobId,
            lastEditorUserId: aliceId,
            text: "# Tool document",
        });
        expect(
            (await alice.getSurfaceDocumentVersion(created.id, document.version)).revision,
        ).toMatchObject({
            actor: { userId: aliceId, agentId: admin.agent.id },
            source: "tool",
            mutationId: null,
        });
        for (const tool of [
            { name: "read_document", arguments: { surfaceId: created.id } },
            {
                name: "read_document",
                arguments: { surfaceId: created.id, version: document.version },
            },
            { name: "list_document_versions", arguments: { surfaceId: created.id, limit: 1 } },
        ]) {
            nextTool = tool;
            await gym.send("Read the document and its history.", { permissionMode: "read_only" });
        }
        expect(
            gym.inference
                .toolResults()
                .some((result) => JSON.stringify(result).includes("# Tool document")),
        ).toBe(true);
        expect((await alice.listSurfaceDocumentVersions(created.id)).versions).toHaveLength(1);
        await gym.restart();
        expect((await bob.getSurfaceDocument(created.id)).document).toEqual(document);
        expect(gym.errors).toEqual([]);
    });

    it.each(["create_document_surface", "update_document"] as const)(
        "reviews %s before allowing or denying a shared write",
        async (toolName) => {
            for (const decision of ["allow", "deny"] as const) {
                let agentId = "";
                let called = false;
                let input: unknown;
                const reviews: string[] = [];
                const gym = await createAgentGym({
                    permissionMode: "auto",
                    inference(request) {
                        if (request.sessionId.startsWith("naming:"))
                            return {
                                content: [{ type: "text", text: "<title>Document review</title>" }],
                            };
                        if (request.sessionId !== agentId) {
                            reviews.push(JSON.stringify(request.messages));
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `<review><outcome>${decision}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                                    },
                                ],
                            };
                        }
                        if (called) return { content: [{ type: "text", text: "Finished." }] };
                        called = true;
                        return {
                            content: [{ type: "tool_call", name: toolName, arguments: input }],
                        };
                    },
                });
                running.push(gym);
                const surface = (
                    await gym.client.createSurface({ type: "document", name: "Original" })
                ).surface;
                const original = (await gym.client.getSurfaceDocument(surface.id)).document;
                agentId =
                    toolName === "create_document_surface"
                        ? (await gym.client.createBot({ name: "Administrator", isAdmin: true })).bot
                              .agent.id
                        : gym.defaultSessionId;
                input =
                    toolName === "create_document_surface"
                        ? { name: "Reviewed document", creatorUserId: null, text: "Reviewed" }
                        : { surfaceId: surface.id, version: original.version, text: "Reviewed" };
                await gym.send("Write the reviewed shared document.", {
                    sessionId: agentId,
                    permissionMode: "auto",
                });
                expect(reviews).toHaveLength(1);
                expect(reviews[0]).toContain("Write the reviewed shared document.");
                expect(reviews[0]).toContain(toolName);
                expect(reviews[0]).toContain("shared data write");
                if (toolName === "create_document_surface")
                    expect((await gym.client.listSurfaces()).surfaces).toHaveLength(
                        decision === "allow" ? 2 : 1,
                    );
                else {
                    expect((await gym.client.getSurfaceDocument(surface.id)).document.text).toBe(
                        decision === "allow" ? "Reviewed" : "",
                    );
                    expect(
                        (await gym.client.listSurfaceDocumentVersions(surface.id)).versions,
                    ).toHaveLength(decision === "allow" ? 2 : 1);
                }
                expect(gym.errors).toEqual([]);
                expect(gym.inference.unscripted).toEqual([]);
                await gym.dispose();
                running.splice(running.indexOf(gym), 1);
            }
        },
    );

    it("keeps verbatim full revisions, immutable mutation IDs, no-ops, and catalog independence across restart", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const surface = (
            await client.createSurface({
                type: "document",
                name: "Notes",
                text: "# Notes\r\n\n",
                mutationId: "initial",
            })
        ).surface;
        expect(surface.type).toBe("document");
        const snapshot = await client.getSurfaceDocument(surface.id);
        const initial = snapshot.document;
        expect(initial).toMatchObject({
            surfaceId: surface.id,
            text: "# Notes\r\n\n",
            authorUserId: null,
            lastEditorUserId: null,
        });
        expect(initial.version).not.toBe(surface.version);
        expect(
            (await client.getSurfaceDocumentVersion(surface.id, initial.version)).revision,
        ).toEqual({
            document: initial,
            actor: { userId: null, agentId: null },
            source: "api",
            mutationId: "initial",
        });
        const changed = (
            await client.updateSurfaceDocument(
                surface.id,
                { text: " \t\r\n", mutationId: "save" },
                { ifMatch: initial.version },
            )
        ).document;
        expect(changed.text).toBe(" \t\r\n");
        expect(changed.version).not.toBe(initial.version);
        expect(
            (
                await client.updateSurfaceDocument(
                    surface.id,
                    { text: changed.text, mutationId: "noop" },
                    { ifMatch: changed.version },
                )
            ).document,
        ).toEqual(changed);
        await expect(
            client.updateSurfaceDocument(
                surface.id,
                { text: changed.text, mutationId: "stale" },
                { ifMatch: initial.version },
            ),
        ).rejects.toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: changed.version, document: changed },
        });
        const cleared = (
            await client.updateSurfaceDocument(
                surface.id,
                { text: "", mutationId: "save" },
                { ifMatch: changed.version },
            )
        ).document;
        const restored = (
            await client.updateSurfaceDocument(
                surface.id,
                { text: initial.text },
                { ifMatch: cleared.version },
            )
        ).document;
        expect(restored.text).toBe(initial.text);
        expect(
            (
                await client.createSurface({
                    id: surface.id,
                    type: "document",
                    name: "Ignored retry",
                    text: "Ignored",
                    mutationId: "retry",
                })
            ).surface,
        ).toEqual(surface);
        expect((await client.getSurfaceDocument(surface.id)).document).toEqual(restored);
        const history = await client.listSurfaceDocumentVersions(surface.id);
        expect(history.versions.map((entry) => entry.version)).toEqual([
            initial.version,
            changed.version,
            cleared.version,
            restored.version,
        ]);
        expect(history.versions.map((entry) => entry.mutationId)).toEqual([
            "initial",
            "save",
            "save",
            null,
        ]);
        expect(
            history.versions.every((entry) => !("text" in entry) && !("document" in entry)),
        ).toBe(true);
        for (const document of [initial, changed, cleared, restored])
            expect(
                (await client.getSurfaceDocumentVersion(surface.id, document.version)).revision
                    .document,
            ).toEqual(document);
        const firstPage = await client.listSurfaceDocumentVersions(surface.id, { limit: 2 });
        expect(firstPage.versions).toEqual(history.versions.slice(0, 2));
        expect(firstPage.nextAfterVersion).toBe(changed.version);
        expect(
            await client.listSurfaceDocumentVersions(surface.id, {
                afterVersion: changed.version,
                limit: 2,
            }),
        ).toEqual({ versions: history.versions.slice(2), nextAfterVersion: null });
        await gym.waitForEvent(
            (event) =>
                event.type === "surface.document.updated" &&
                event.payload.version === restored.version,
            "the restored document event",
        );
        const events = (
            await client.getEvents({ after: snapshot.cursor, limit: 1000 })
        ).events.filter((event) => event.type === "surface.document.updated");
        expect(events.map((event) => event.payload)).toEqual([
            {
                surfaceId: surface.id,
                previousVersion: initial.version,
                version: changed.version,
                changes: {
                    text: changed.text,
                    lastEditorUserId: null,
                    updatedAt: changed.updatedAt,
                },
                mutationId: "save",
            },
            {
                surfaceId: surface.id,
                previousVersion: changed.version,
                version: cleared.version,
                changes: {
                    text: cleared.text,
                    lastEditorUserId: null,
                    updatedAt: cleared.updatedAt,
                },
                mutationId: "save",
            },
            {
                surfaceId: surface.id,
                previousVersion: cleared.version,
                version: restored.version,
                changes: {
                    text: restored.text,
                    lastEditorUserId: null,
                    updatedAt: restored.updatedAt,
                },
            },
        ]);
        expect((await client.listSurfaces()).surfaces).toEqual([surface]);
        await gym.restart();
        expect((await gym.client.getSurfaceDocument(surface.id)).document).toEqual(restored);
        expect(await gym.client.listSurfaceDocumentVersions(surface.id)).toEqual(history);
        expect((await gym.client.getDesktopBootstrap()).surfaces).toEqual([surface]);
        expect(gym.errors).toEqual([]);
    });
});
