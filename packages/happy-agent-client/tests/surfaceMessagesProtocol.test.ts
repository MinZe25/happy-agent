import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    surfaceMessageCreatedPayloadSchema,
    surfaceMessageUpdatedPayloadSchema,
} from "../sources/protocol/events.js";
import {
    createSurfaceRequestSchema,
    editSurfaceMessageRequestSchema,
    sendSurfaceMessageRequestSchema,
    surfaceMessagePageResponseSchema,
    surfaceMessageRevisionSchema,
    surfaceMessageSchema,
    surfaceMessageVersionListResponseSchema,
    type SurfaceMessage,
    type SurfaceMessageRevision,
} from "../sources/protocol/surfaces.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const now = 1_755_400_000_000;
const surfaceId = "s12345678901234567890123";
const message: SurfaceMessage = {
    id: "m4k8m2q9w1e5r7y3u6i0o2p4",
    surfaceId,
    seq: 42,
    authorUserId: "u1x2y3z4a5b6c7d8e9f0g1h2",
    text: "Shipping the **beta** on Friday.\n\n- notes",
    status: "active",
    createdAt: now,
    updatedAt: now,
    editedAt: null,
    deletedAt: null,
    version,
};
const revision: SurfaceMessageRevision = {
    message,
    actor: { userId: "u1x2y3z4a5b6c7d8e9f0g1h2", agentId: null },
    source: "api",
};

describe("chat Surface message protocol", () => {
    it("creates chat Surfaces with the shared catalog fields and advertises them in health", () => {
        expect(
            Value.Check(createSurfaceRequestSchema, {
                type: "chat",
                name: "Design team",
                id: surfaceId,
                image: { data: "AAAA" },
                mutationId: "create",
            }),
        ).toBe(true);
        expect(
            Value.Check(createSurfaceRequestSchema, { type: "chat", name: "Team", text: "hi" }),
        ).toBe(false);
        expect(
            Value.Check(healthResponseSchema.properties.capabilities, { chatSurfaces: true }),
        ).toBe(true);
    });

    it("models posted Markdown with immutable authors, seq, edits, and tombstones", () => {
        expect(Value.Check(surfaceMessageSchema, message)).toBe(true);
        expect(Value.Check(surfaceMessageSchema, { ...message, authorUserId: null })).toBe(true);
        expect(
            Value.Check(surfaceMessageSchema, {
                ...message,
                editedAt: now,
                status: "deleted",
                deletedAt: now,
            }),
        ).toBe(true);
        expect(Value.Check(surfaceMessageSchema, { ...message, deletedAt: now })).toBe(false);
        expect(
            Value.Check(surfaceMessageSchema, { ...message, status: "deleted", deletedAt: null }),
        ).toBe(false);
        expect(Value.Check(surfaceMessageSchema, { ...message, seq: 0 })).toBe(false);
        expect(Value.Check(surfaceMessageSchema, { ...message, text: " \n\t" })).toBe(false);
        expect(Value.Check(surfaceMessageSchema, { ...message, text: "a\u0000b" })).toBe(false);
        expect(Value.Check(surfaceMessageSchema, { ...message, text: "x".repeat(20_000) })).toBe(
            true,
        );
        expect(Value.Check(surfaceMessageSchema, { ...message, text: "x".repeat(20_001) })).toBe(
            false,
        );
        const { editedAt: _editedAt, ...withoutEdit } = message;
        expect(Value.Check(surfaceMessageSchema, withoutEdit)).toBe(false);
    });

    it("never lets a request body supply an author, seq, or status", () => {
        expect(Value.Check(sendSurfaceMessageRequestSchema, { text: "hi" })).toBe(true);
        expect(
            Value.Check(sendSurfaceMessageRequestSchema, {
                text: "hi",
                id: message.id,
                mutationId: "m",
            }),
        ).toBe(true);
        for (const extra of [{ authorUserId: null }, { seq: 1 }, { status: "deleted" }])
            expect(Value.Check(sendSurfaceMessageRequestSchema, { text: "hi", ...extra })).toBe(
                false,
            );
        expect(Value.Check(editSurfaceMessageRequestSchema, { text: "fixed" })).toBe(true);
        expect(Value.Check(editSurfaceMessageRequestSchema, { mutationId: "m" })).toBe(false);
        expect(Value.Check(editSurfaceMessageRequestSchema, { text: "x", status: "active" })).toBe(
            false,
        );
    });

    it("carries pages, revisions, and shared events", () => {
        expect(
            Value.Check(surfaceMessagePageResponseSchema, {
                messages: [message],
                nextBeforeSeq: 42,
                nextAfterSeq: null,
                cursor: "1",
            }),
        ).toBe(true);
        expect(
            Value.Check(surfaceMessagePageResponseSchema, {
                messages: [],
                nextBeforeSeq: null,
                nextAfterSeq: null,
                cursor: "1",
            }),
        ).toBe(true);
        expect(Value.Check(surfaceMessageRevisionSchema, revision)).toBe(true);
        expect(
            Value.Check(surfaceMessageVersionListResponseSchema, {
                versions: [revision],
                nextAfterVersion: null,
            }),
        ).toBe(true);
        expect(
            Value.Check(surfaceMessageCreatedPayloadSchema, { message, mutationId: "post" }),
        ).toBe(true);
        expect(
            Value.Check(surfaceMessageUpdatedPayloadSchema, {
                surfaceId,
                messageId: message.id,
                previousVersion: version,
                version: nextVersion,
                changes: { text: "fixed", editedAt: now, updatedAt: now },
            }),
        ).toBe(true);
        expect(
            Value.Check(surfaceMessageUpdatedPayloadSchema, {
                surfaceId,
                messageId: message.id,
                previousVersion: version,
                version: nextVersion,
                changes: { status: "deleted", deletedAt: now, updatedAt: now },
            }),
        ).toBe(true);
        expect(
            Value.Check(surfaceMessageUpdatedPayloadSchema, {
                surfaceId,
                messageId: message.id,
                previousVersion: version,
                version: nextVersion,
                changes: { text: "fixed" },
            }),
        ).toBe(false);
    });

    it("uses the messages prefix, encodes identities, and sends version guards", async () => {
        const requests: { method: string; url: string; body: unknown; ifMatch: string | null }[] =
            [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                method: init?.method ?? "GET",
                url: input.toString(),
                body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                ifMatch: new Headers(init?.headers).get("if-match"),
            });
            return new Response(JSON.stringify({ message }), { status: 200 });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        await client.listSurfaceMessages(surfaceId);
        await client.listSurfaceMessages(surfaceId, { beforeSeq: 42, limit: 20 });
        await client.listSurfaceMessages(surfaceId, { afterSeq: 41 });
        await client.sendSurfaceMessage(surfaceId, { id: message.id, text: "hi" });
        await client.getSurfaceMessage(surfaceId, "message/1");
        await client.editSurfaceMessage(
            surfaceId,
            message.id,
            { text: "fixed" },
            { ifMatch: version },
        );
        await client.deleteSurfaceMessage(surfaceId, message.id, {
            ifMatch: nextVersion,
            mutationId: "delete",
        });
        await client.listSurfaceMessageVersions(surfaceId, message.id, {
            afterVersion: version,
            limit: 2,
        });
        await client.getSurfaceMessageVersion(surfaceId, message.id, "version/1");

        const base = `http://agent.local/v0/surfaces/chat/${surfaceId}/messages`;
        expect(requests).toEqual([
            { method: "GET", url: base, body: null, ifMatch: null },
            { method: "GET", url: `${base}?beforeSeq=42&limit=20`, body: null, ifMatch: null },
            { method: "GET", url: `${base}?afterSeq=41`, body: null, ifMatch: null },
            {
                method: "POST",
                url: base,
                body: { id: message.id, text: "hi" },
                ifMatch: null,
            },
            { method: "GET", url: `${base}/message%2F1`, body: null, ifMatch: null },
            {
                method: "PATCH",
                url: `${base}/${message.id}`,
                body: { text: "fixed" },
                ifMatch: version,
            },
            {
                method: "DELETE",
                url: `${base}/${message.id}`,
                body: { mutationId: "delete" },
                ifMatch: nextVersion,
            },
            {
                method: "GET",
                url: `${base}/${message.id}/versions?afterVersion=${version}&limit=2`,
                body: null,
                ifMatch: null,
            },
            {
                method: "GET",
                url: `${base}/${message.id}/versions/version%2F1`,
                body: null,
                ifMatch: null,
            },
        ]);
    });

    it("exposes the current message on conflicts and refuses non-authors without retrying", async () => {
        const replies = [
            {
                status: 409,
                body: {
                    error: "The message has changed.",
                    code: "conflict",
                    currentVersion: nextVersion,
                    message: { ...message, version: nextVersion },
                },
            },
            {
                status: 403,
                body: { error: "Only its author can change this message.", code: "forbidden" },
            },
        ];
        let calls = 0;
        const fetch: typeof globalThis.fetch = async () => {
            const reply = replies[calls]!;
            calls += 1;
            return new Response(JSON.stringify(reply.body), { status: reply.status });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const conflict = await client
            .editSurfaceMessage(surfaceId, message.id, { text: "x" }, { ifMatch: version })
            .catch((caught: unknown) => caught);
        expect(conflict).toBeInstanceOf(HappyAgentApiError);
        expect(conflict).toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: nextVersion, message: { ...message, version: nextVersion } },
        });
        const forbidden = await client
            .deleteSurfaceMessage(surfaceId, message.id, { ifMatch: version })
            .catch((caught: unknown) => caught);
        expect(forbidden).toMatchObject({ status: 403, code: "forbidden" });
        expect(calls).toBe(2);
    });
});
