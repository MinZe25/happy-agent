import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    createSurfaceRequestSchema,
    sendSurfaceDocumentPresenceRequestSchema,
    sendSurfaceDocumentUpdateRequestSchema,
    surfaceDocumentChangeListResponseSchema,
    surfaceDocumentChangeSchema,
    surfaceDocumentPresenceFrameSchema,
    surfaceDocumentRevisionSchema,
    surfaceDocumentSchema,
    surfaceDocumentSnapshotResponseSchema,
    surfaceDocumentStateResponseSchema,
    surfaceDocumentSubscriptionRequestSchema,
    surfaceDocumentUpdateFrameSchema,
    surfaceDocumentVersionListResponseSchema,
    surfaceDocumentVersionSummarySchema,
    type SurfaceDocument,
    type SurfaceDocumentChange,
    type SurfaceDocumentRevision,
    type SurfaceDocumentVersionSummary,
} from "../sources/protocol/surfaces.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const now = 1_755_400_000_000;
const streamId = "k8m2q9w1e5r7y3u6i0o2p4s1";
const document: SurfaceDocument = {
    surfaceId: "s12345678901234567890123",
    text: "# Notes\n",
    authorUserId: "user1",
    lastEditorUserId: "user2",
    createdAt: now,
    updatedAt: now,
    version,
    seq: 42,
};
const { seq: _seq, ...frozen } = document;
const revision = {
    document: frozen,
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
const change: SurfaceDocumentChange = {
    seq: 43,
    actor: { userId: "user2", agentId: null },
    source: "api",
    mutationId: "typing-1",
    createdAt: now,
    size: 318,
};

describe("Document Surface protocol", () => {
    it("creates documents from bounded Markdown and advertises collaboration through health", () => {
        for (const text of ["", " \t\r\n", "a".repeat(262_144), "🙂".repeat(131_072)])
            expect(
                Value.Check(createSurfaceRequestSchema, { type: "document", name: "Notes", text }),
            ).toBe(true);
        for (const text of ["a\0b", "a".repeat(262_145), null, 1])
            expect(
                Value.Check(createSurfaceRequestSchema, { type: "document", name: "Notes", text }),
            ).toBe(false);
        const health = { healthy: true, ready: true, status: "ready" };
        const versioned = { ...health, version: { protocol: 26, daemon: "0.4.98" } };
        expect(
            Value.Check(healthResponseSchema, {
                ...versioned,
                capabilities: { collaborativeDocuments: true },
            }),
        ).toBe(true);
        expect(Value.Check(healthResponseSchema, versioned)).toBe(true);
    });

    it("reads the Markdown projection with an optional seq and older daemons without one", () => {
        expect(Value.Check(surfaceDocumentSchema, document)).toBe(true);
        expect(Value.Check(surfaceDocumentSchema, frozen)).toBe(true);
        expect(Value.Check(surfaceDocumentSchema, { ...document, seq: 0 })).toBe(true);
        for (const seq of [-1, 1.5, "1"])
            expect(Value.Check(surfaceDocumentSchema, { ...document, seq })).toBe(false);
        expect(
            Value.Check(surfaceDocumentSnapshotResponseSchema, { document, cursor: version }),
        ).toBe(true);
        expect(Value.Check(surfaceDocumentSnapshotResponseSchema, { document })).toBe(false);
    });

    it("keeps frozen Markdown revisions readable as history", () => {
        expect(Value.Check(surfaceDocumentRevisionSchema, revision)).toBe(true);
        expect(
            Value.Check(surfaceDocumentVersionListResponseSchema, {
                versions: [summary],
                nextAfterVersion: null,
            }),
        ).toBe(true);
        expect(surfaceDocumentVersionSummarySchema.properties).not.toHaveProperty("text");
        const { mutationId: _mutationId, ...olderRevision } = revision;
        expect(Value.Check(surfaceDocumentRevisionSchema, olderRevision)).toBe(true);
    });

    it("bounds changes, requires mutation IDs, and describes the permanent log without bytes", () => {
        const update = "AQHIx9s0AAQBBmRvY3VtZW50";
        expect(
            Value.Check(sendSurfaceDocumentUpdateRequestSchema, { mutationId: "m", update }),
        ).toBe(true);
        for (const invalid of [
            { update },
            { mutationId: "m" },
            { mutationId: "m", update: "not base64!" },
            { mutationId: "m", update: "A".repeat(1_398_105) },
            { mutationId: "m", update, text: "# Notes" },
        ])
            expect(Value.Check(sendSurfaceDocumentUpdateRequestSchema, invalid)).toBe(false);
        expect(Value.Check(surfaceDocumentChangeSchema, change)).toBe(true);
        expect(Value.Check(surfaceDocumentChangeSchema, { ...change, source: "conversion" })).toBe(
            true,
        );
        expect(Value.Check(surfaceDocumentChangeSchema, { ...change, seq: 0 })).toBe(false);
        expect(Value.Check(surfaceDocumentChangeSchema, { ...change, mutationId: null })).toBe(
            true,
        );
        expect(surfaceDocumentChangeSchema.properties).not.toHaveProperty("update");
        expect(
            Value.Check(surfaceDocumentChangeListResponseSchema, {
                updates: [change],
                nextAfterSeq: 43,
            }),
        ).toBe(true);
        expect(
            Value.Check(surfaceDocumentStateResponseSchema, {
                seq: 0,
                update: "",
                stateVector: "",
            }),
        ).toBe(true);
    });

    it("validates subscriptions, presence, and both live frame shapes", () => {
        expect(Value.Check(surfaceDocumentSubscriptionRequestSchema, { streamId })).toBe(true);
        expect(Value.Check(surfaceDocumentSubscriptionRequestSchema, {})).toBe(false);
        expect(
            Value.Check(sendSurfaceDocumentPresenceRequestSchema, {
                streamId,
                awarenessClientId: 123,
                update: "AQ==",
            }),
        ).toBe(true);
        expect(
            Value.Check(sendSurfaceDocumentPresenceRequestSchema, { streamId, update: "AQ==" }),
        ).toBe(false);
        expect(
            Value.Check(surfaceDocumentUpdateFrameSchema, {
                surfaceId: document.surfaceId,
                seq: 43,
                update: "AQ==",
                mutationId: null,
                actor: change.actor,
                source: "tool",
            }),
        ).toBe(true);
        const presence = {
            surfaceId: document.surfaceId,
            clientKey: "c1",
            revision: 7,
            active: true,
            awarenessClientId: 123,
            update: "AQ==",
        };
        expect(Value.Check(surfaceDocumentPresenceFrameSchema, presence)).toBe(true);
        const { update: _update, ...inactive } = { ...presence, active: false, revision: 8 };
        expect(Value.Check(surfaceDocumentPresenceFrameSchema, inactive)).toBe(true);
    });

    it("uses encoded document routes with query and body fields exactly as specified", async () => {
        const requests: { method: string; url: string; body: unknown }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                requests.push({
                    method: init?.method ?? "GET",
                    url: input.toString(),
                    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                });
                return new Response(JSON.stringify({}), { status: 200 });
            },
        });
        const id = "surface/1";
        await client.getSurfaceDocument(id, { seq: 3 });
        await client.getSurfaceDocumentState(id, { stateVector: "AA==" });
        await client.getSurfaceDocumentState(id, { seq: 3 });
        await client.sendSurfaceDocumentUpdate(id, { mutationId: "m1", update: "AQ==" });
        await client.listSurfaceDocumentUpdates(id, { afterSeq: 40, limit: 2 });
        await client.subscribeSurfaceDocument(id, { streamId });
        await client.unsubscribeSurfaceDocument(id, { streamId });
        await client.sendSurfaceDocumentPresence(id, {
            streamId,
            awarenessClientId: 7,
            update: "AQ==",
        });
        const base = "http://agent.local/v0/surfaces/document/surface%2F1";
        expect(requests).toEqual([
            { method: "GET", url: `${base}?seq=3`, body: null },
            { method: "GET", url: `${base}/state?stateVector=AA%3D%3D`, body: null },
            { method: "GET", url: `${base}/state?seq=3`, body: null },
            { method: "POST", url: `${base}/updates`, body: { mutationId: "m1", update: "AQ==" } },
            { method: "GET", url: `${base}/updates?afterSeq=40&limit=2`, body: null },
            { method: "POST", url: `${base}/subscribe`, body: { streamId } },
            { method: "POST", url: `${base}/unsubscribe`, body: { streamId } },
            {
                method: "POST",
                url: `${base}/presence`,
                body: { streamId, awarenessClientId: 7, update: "AQ==" },
            },
        ]);
    });

    it("surfaces the withdrawn save method as an ordinary API error", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        error: "Editing this document needs a newer Happy.",
                        code: "method_not_allowed",
                    }),
                    { status: 405 },
                ),
        });
        const error = await client
            .sendSurfaceDocumentUpdate(document.surfaceId, { mutationId: "m", update: "AQ==" })
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({ status: 405, code: "method_not_allowed" });
    });
});
