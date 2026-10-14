import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import type { Agent } from "../sources/protocol/agents.js";
import { surfaceUpdatedPayloadSchema } from "../sources/protocol/events.js";
import {
    ensureSurfaceChatRequestSchema,
    surfaceChatResponseSchema,
    surfaceSchema,
    type Surface,
} from "../sources/protocol/surfaces.js";
import { workspaceSchema, type Workspace } from "../sources/protocol/workspaces.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const now = 1_755_400_000_000;
const agent: Agent = {
    archivedAt: null,
    canSendMessages: true,
    createdAt: now,
    id: "agent1",
    lastCursor: version,
    managedByAnotherAgent: false,
    orderKey: null,
    parentAgentId: null,
    pendingQuestionId: null,
    processes: { running: 0 },
    status: "idle",
    subagents: { running: 0, total: 0 },
    title: "Inbox",
    titleStatus: "ready",
    unread: null,
    updatedAt: now,
    userVisible: true,
    version,
    workspaceId: "workspace1",
};
const surface: Surface = {
    id: "s12345678901234567890123",
    type: "todo",
    name: "Inbox",
    image: null,
    members: [],
    creatorUserId: null,
    version,
    updatedAt: now,
};
const opened = { surface: { ...surface, chatAgentId: agent.id, version: nextVersion }, agent };

describe("Shared Surface chat protocol", () => {
    it("keeps chat associations optional for older catalogs and requires a full successful ensure", () => {
        expect(Value.Check(surfaceSchema, surface)).toBe(true);
        expect(surfaceSchema.required).not.toContain("chatAgentId");
        expect(Value.Check(surfaceSchema, { ...surface, chatAgentId: null })).toBe(true);
        expect(Value.Check(surfaceSchema, opened.surface)).toBe(true);
        expect(Value.Check(surfaceSchema, { ...surface, chatAgentId: 42 })).toBe(false);
        expect(Value.Check(surfaceChatResponseSchema, opened)).toBe(true);
        expect(Value.Check(surfaceChatResponseSchema, { ...opened, surface })).toBe(false);
        expect(
            Value.Check(surfaceChatResponseSchema, {
                ...opened,
                surface: { ...surface, chatAgentId: null },
            }),
        ).toBe(false);
        expect(Value.Check(surfaceChatResponseSchema, { ...opened, agent: null })).toBe(false);
    });

    it("accepts only an optional mutation echo, not caller-selected identities or permission defaults", () => {
        expect(Value.Check(ensureSurfaceChatRequestSchema, {})).toBe(true);
        expect(Value.Check(ensureSurfaceChatRequestSchema, { mutationId: "open" })).toBe(true);
        for (const input of [
            { agentId: "agent1" },
            { workspaceId: "workspace1" },
            { ownerUserId: "user1" },
            { text: "Initial message" },
            { modelId: "selected" },
            { permissionMode: "full_access" },
            { mode: { permissionMode: "full_access" } },
        ])
            expect(Value.Check(ensureSurfaceChatRequestSchema, input)).toBe(false);
    });

    it("adds a dedicated Surface workspace kind without adding fields required by older workspaces", () => {
        const workspace: Workspace = {
            id: "workspace1",
            agents: [agent],
            archivedAt: null,
            base: null,
            botId: null,
            compute: { type: "host", path: "/tmp/happy/Surfaces/surface1" },
            createdAt: now,
            creatorAgentId: null,
            git: null,
            initialization: { status: "ready", attempt: 0, error: null },
            kind: "surface",
            name: "surface1",
            nameSource: "user",
            orderKey: "5",
            parentId: null,
            projectId: null,
            status: "active",
            surfaceId: surface.id,
            updatedAt: now,
            version,
        };
        expect(Value.Check(workspaceSchema, workspace)).toBe(true);
        expect(workspaceSchema.required).not.toContain("surfaceId");
        expect(Value.Check(workspaceSchema, { ...workspace, surfaceId: "todo" })).toBe(false);
        const { surfaceId: _surfaceId, ...older } = workspace;
        expect(Value.Check(workspaceSchema, { ...older, kind: "task", taskId: "task1" })).toBe(
            true,
        );
    });

    it("keeps members and timestamps in chat-only Surface updates while allowing old event payloads", () => {
        const payload = {
            surfaceId: surface.id,
            previousVersion: version,
            version: nextVersion,
            changes: { members: [], updatedAt: now },
            mutationId: "open",
        };
        expect(Value.Check(surfaceUpdatedPayloadSchema, payload)).toBe(true);
        expect(
            Value.Check(surfaceUpdatedPayloadSchema, {
                ...payload,
                changes: { ...payload.changes, chatAgentId: agent.id },
            }),
        ).toBe(true);
        expect(
            Value.Check(surfaceUpdatedPayloadSchema, {
                ...payload,
                changes: { updatedAt: now, chatAgentId: agent.id },
            }),
        ).toBe(false);
    });

    it("uses the encoded POST chat route with no peek or implicit send", async () => {
        const sent: {
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
                sent.push({
                    method: init?.method ?? "GET",
                    url: input.toString(),
                    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                    ifMatch: new Headers(init?.headers).get("if-match"),
                    signal: init?.signal,
                });
                return new Response(JSON.stringify(opened), { status: 200 });
            },
        });
        for (const id of [surface.id, "surface/1"]) {
            await expect(
                client.ensureSurfaceChat(id, { mutationId: "open", signal: controller.signal }),
            ).resolves.toEqual(opened);
        }
        expect(sent).toEqual(
            [surface.id, "surface%2F1"].map((id) => ({
                method: "POST",
                url: `http://agent.local/v0/surfaces/${id}/chat`,
                body: { mutationId: "open" },
                ifMatch: null,
                signal: controller.signal,
            })),
        );
        await client.createTodo(surface.id, { text: "Existing route" });
        expect(sent.at(-1)!.url).toBe(`http://agent.local/v0/surfaces/todo/${surface.id}`);
        await client.ensureSurfaceChat(surface.id);
        expect(sent.at(-1)!.body).toEqual({});
    });

    it.each([
        [409, "conflict"],
        [404, "not_found"],
        [501, "unsupported"],
        [503, "not_initialized"],
    ] as const)(
        "preserves %s failures without retrying or creating a fallback task",
        async (status, code) => {
            let calls = 0;
            const client = new HappyAgentClient({
                endpoint: "http://agent.local",
                token: "t",
                fetch: async () => {
                    calls += 1;
                    return new Response(
                        JSON.stringify({ error: "The Surface chat is unavailable.", code }),
                        { status },
                    );
                },
            });
            await expect(client.ensureSurfaceChat(surface.id)).rejects.toMatchObject({
                status,
                code,
            });
            expect(calls).toBe(1);
        },
    );
});
