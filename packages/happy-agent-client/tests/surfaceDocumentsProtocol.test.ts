import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import {
    surfaceDocumentUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";
import {
    createSurfaceRequestSchema,
    surfaceDocumentRevisionSchema,
    surfaceDocumentSchema,
    surfaceDocumentSnapshotResponseSchema,
    surfaceDocumentVersionListResponseSchema,
    surfaceDocumentVersionSummarySchema,
    updateSurfaceDocumentRequestSchema,
    type SurfaceDocument,
    type SurfaceDocumentRevision,
    type SurfaceDocumentVersionSummary,
} from "../sources/protocol/surfaces.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const now = 1_755_400_000_000;
const document: SurfaceDocument = {
    surfaceId: "s12345678901234567890123",
    text: "# Notes\r\n\n",
    authorUserId: "user1",
    lastEditorUserId: "user2",
    createdAt: now,
    updatedAt: now,
    version,
};
const revision = {
    document,
    actor: { userId: "user2", agentId: "agent1" },
    mutationId: "save-1",
    source: "tool",
} satisfies SurfaceDocumentRevision;
const summary: SurfaceDocumentVersionSummary = {
    version,
    updatedAt: now,
    actor: revision.actor,
    mutationId: revision.mutationId,
    source: revision.source,
};

describe("Document Surface protocol", () => {
    it("accepts bounded verbatim Markdown and rejects attribution or partial-update inputs", () => {
        expect(Value.Check(createSurfaceRequestSchema, { type: "document", name: "Notes" })).toBe(
            true,
        );
        for (const text of [
            "",
            " \t\r\n",
            document.text,
            "a".repeat(262_144),
            "🙂".repeat(131_072),
        ]) {
            expect(
                Value.Check(createSurfaceRequestSchema, { type: "document", name: "Notes", text }),
            ).toBe(true);
            expect(
                Value.Check(updateSurfaceDocumentRequestSchema, { text, mutationId: "edit" }),
            ).toBe(true);
        }
        for (const text of ["a\0b", "a".repeat(262_145), "🙂".repeat(131_073), null, 1]) {
            expect(Value.Check(updateSurfaceDocumentRequestSchema, { text })).toBe(false);
            expect(
                Value.Check(createSurfaceRequestSchema, { type: "document", name: "Notes", text }),
            ).toBe(false);
        }
        for (const input of [
            {},
            { mutationId: "only" },
            { text: "x", authorUserId: "user1" },
            { text: "x", lastEditorUserId: null },
            { text: "x", version },
            { text: "x", actor: revision.actor },
            { text: "x", patch: [] },
        ])
            expect(Value.Check(updateSurfaceDocumentRequestSchema, input)).toBe(false);
        expect(
            Value.Check(createSurfaceRequestSchema, {
                type: "separator",
                name: "Section",
                text: "Not contentless",
            }),
        ).toBe(false);
    });

    it("keeps author attribution distinct from revision actors and bounds history pages to metadata", () => {
        expect(Value.Check(surfaceDocumentSchema, document)).toBe(true);
        expect(
            Value.Check(surfaceDocumentSchema, {
                ...document,
                authorUserId: null,
                lastEditorUserId: null,
            }),
        ).toBe(true);
        expect(Value.Check(surfaceDocumentRevisionSchema, revision)).toBe(true);
        expect(document.authorUserId).not.toBe(revision.actor.userId);
        expect(
            Value.Check(surfaceDocumentSnapshotResponseSchema, { document, cursor: version }),
        ).toBe(true);
        expect(Value.Check(surfaceDocumentSnapshotResponseSchema, { document })).toBe(false);
        expect(
            Value.Check(surfaceDocumentVersionListResponseSchema, {
                versions: [summary],
                nextAfterVersion: null,
            }),
        ).toBe(true);
        expect(surfaceDocumentVersionSummarySchema.properties).not.toHaveProperty("text");
        expect(surfaceDocumentVersionSummarySchema.properties).not.toHaveProperty("document");
        expect(Value.Check(surfaceDocumentRevisionSchema, { ...revision, actor: undefined })).toBe(
            false,
        );
    });

    it("accepts immutable correlation metadata while preserving older revision responses", () => {
        for (const mutationId of ["save-1", "", null]) {
            expect(Value.Check(surfaceDocumentRevisionSchema, { ...revision, mutationId })).toBe(
                true,
            );
            expect(
                Value.Check(surfaceDocumentVersionSummarySchema, { ...summary, mutationId }),
            ).toBe(true);
        }
        for (const mutationId of [42, {}, []]) {
            expect(Value.Check(surfaceDocumentRevisionSchema, { ...revision, mutationId })).toBe(
                false,
            );
            expect(
                Value.Check(surfaceDocumentVersionSummarySchema, { ...summary, mutationId }),
            ).toBe(false);
        }
        const { mutationId: _revisionMutationId, ...olderRevision } = revision;
        const { mutationId: _summaryMutationId, ...olderSummary } = summary;
        expect(Value.Check(surfaceDocumentRevisionSchema, olderRevision)).toBe(true);
        expect(Value.Check(surfaceDocumentVersionSummarySchema, olderSummary)).toBe(true);
        expect(surfaceDocumentRevisionSchema.required).not.toContain("mutationId");
        expect(surfaceDocumentVersionSummarySchema.required).not.toContain("mutationId");
        expect(surfaceDocumentSchema.properties).not.toHaveProperty("mutationId");
    });

    it("recovers a lost save's exact revision even after another edit, without replaying the write", async () => {
        const saved = {
            ...revision,
            source: "api" as const,
            document: { ...document, text: "My saved text", version: nextVersion },
        };
        const laterVersion = "01991f3a-7e30-7000-8000-4b1c2d3e4f50";
        let writes = 0;
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                if (init?.method === "PUT") {
                    writes += 1;
                    throw new Error("The save response was lost.");
                }
                const path = new URL(input.toString());
                if (path.pathname.endsWith("/versions")) {
                    expect(path.searchParams.get("afterVersion")).toBe(version);
                    return new Response(
                        JSON.stringify({
                            versions: [
                                { ...summary, version: nextVersion, source: "api" },
                                { ...summary, version: laterVersion, mutationId: "other-save" },
                            ],
                            nextAfterVersion: null,
                        }),
                        { status: 200 },
                    );
                }
                expect(path.pathname).toBe(
                    `/v0/surfaces/document/${document.surfaceId}/versions/${nextVersion}`,
                );
                return new Response(JSON.stringify({ revision: saved }), { status: 200 });
            },
        });
        await expect(
            client.updateSurfaceDocument(
                document.surfaceId,
                { text: saved.document.text, mutationId: "save-1" },
                { ifMatch: version },
            ),
        ).rejects.toThrow("The save response was lost.");
        const history = await client.listSurfaceDocumentVersions(document.surfaceId, {
            afterVersion: version,
        });
        const ownSave = history.versions.find((entry) => entry.mutationId === "save-1");
        expect(ownSave?.version).toBe(nextVersion);
        if (!ownSave) throw new Error("The committed save was not identified.");
        const recovered = await client.getSurfaceDocumentVersion(
            document.surfaceId,
            ownSave.version,
        );
        expect(recovered.revision.mutationId).toBe("save-1");
        expect(recovered.revision.document.text).toBe("My saved text");
        expect(writes).toBe(1);
    });

    it("defines a shared independently versioned document-change event", () => {
        const event: HappyAgentEvent = {
            type: "surface.document.updated",
            cursor: nextVersion,
            occurredAt: now,
            payload: {
                surfaceId: document.surfaceId,
                previousVersion: version,
                version: nextVersion,
                changes: { text: "Replacement", lastEditorUserId: null, updatedAt: now },
                mutationId: "edit",
            },
        };
        expect(Value.Check(surfaceDocumentUpdatedPayloadSchema, event.payload)).toBe(true);
        expect(
            Value.Check(surfaceDocumentUpdatedPayloadSchema, {
                ...event.payload,
                changes: { text: "Missing audit fields" },
            }),
        ).toBe(false);
    });

    it("uses encoded typed document routes, whole-text PUT, version guards, and bounded history queries", async () => {
        const requests: {
            method: string;
            url: string;
            body: unknown;
            ifMatch: string | null;
            signal: AbortSignal | null | undefined;
        }[] = [];
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                requests.push({
                    method: init?.method ?? "GET",
                    url: input.toString(),
                    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                    ifMatch: new Headers(init?.headers).get("if-match"),
                    signal: init?.signal,
                });
                const body =
                    init?.method === "PUT"
                        ? { document }
                        : input.toString().includes("/versions?")
                          ? { versions: [summary], nextAfterVersion: null }
                          : input.toString().includes("/versions/")
                            ? { revision }
                            : { document, cursor: version };
                return new Response(JSON.stringify(body), { status: 200 });
            },
        });
        await expect(
            client.getSurfaceDocument("surface/1", { signal: controller.signal }),
        ).resolves.toEqual({ document, cursor: version });
        await expect(
            client.updateSurfaceDocument(
                "surface/1",
                { text: document.text, mutationId: "edit" },
                { ifMatch: version, signal: controller.signal },
            ),
        ).resolves.toEqual({ document });
        await expect(
            client.listSurfaceDocumentVersions("surface/1", {
                afterVersion: version,
                limit: 2,
                signal: controller.signal,
            }),
        ).resolves.toEqual({ versions: [summary], nextAfterVersion: null });
        await expect(
            client.getSurfaceDocumentVersion("surface/1", "version/1", {
                signal: controller.signal,
            }),
        ).resolves.toEqual({ revision });
        expect(requests).toEqual([
            {
                method: "GET",
                url: "http://agent.local/v0/surfaces/document/surface%2F1",
                body: null,
                ifMatch: null,
                signal: controller.signal,
            },
            {
                method: "PUT",
                url: "http://agent.local/v0/surfaces/document/surface%2F1",
                body: { text: document.text, mutationId: "edit" },
                ifMatch: version,
                signal: controller.signal,
            },
            {
                method: "GET",
                url: `http://agent.local/v0/surfaces/document/surface%2F1/versions?afterVersion=${version}&limit=2`,
                body: null,
                ifMatch: null,
                signal: controller.signal,
            },
            {
                method: "GET",
                url: "http://agent.local/v0/surfaces/document/surface%2F1/versions/version%2F1",
                body: null,
                ifMatch: null,
                signal: controller.signal,
            },
        ]);
    });

    it("exposes current document conflicts and unsupported-daemon errors without retry or fallback", async () => {
        let calls = 0;
        const current = { ...document, version: nextVersion };
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (_input, init) => {
                calls += 1;
                return init?.method === "PUT"
                    ? new Response(
                          JSON.stringify({
                              error: "The document has changed.",
                              code: "conflict",
                              currentVersion: nextVersion,
                              document: current,
                          }),
                          { status: 409 },
                      )
                    : new Response(
                          JSON.stringify({ error: "Document not found.", code: "not_found" }),
                          { status: 404 },
                      );
            },
        });
        const error = await client
            .updateSurfaceDocument(document.surfaceId, { text: "Edited" }, { ifMatch: version })
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: nextVersion, document: current },
        });
        await expect(client.getSurfaceDocument(document.surfaceId)).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
        expect(calls).toBe(2);
    });
});
