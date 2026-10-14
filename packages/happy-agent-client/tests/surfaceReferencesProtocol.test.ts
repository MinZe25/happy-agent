import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { surfaceCreatedPayloadSchema } from "../sources/protocol/events.js";
import {
    createSurfaceRequestSchema,
    surfaceSchema,
    surfaceTargetSchema,
    type CreateSurfaceRequest,
    type Surface,
    type SurfaceTarget,
} from "../sources/protocol/surfaces.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const surface: Surface = {
    id: "s12345678901234567890123",
    name: "Stored fallback label",
    type: "bot",
    image: null,
    members: [],
    creatorUserId: null,
    version,
    updatedAt: 1_755_400_000_000,
};
const requests = [
    { type: "artifact", name: "Design", artifactId: "artifact1" },
    { type: "bot", name: "Assistant", botId: "bot1" },
    { type: "task", name: "Launch", taskId: "task1" },
] satisfies CreateSurfaceRequest[];

describe("Reference Surface protocol", () => {
    it("requires exactly the target identity belonging to each creation type", () => {
        for (const request of requests) {
            expect(Value.Check(createSurfaceRequestSchema, request)).toBe(true);
            expect(
                Value.Check(createSurfaceRequestSchema, {
                    ...request,
                    image: { data: "aW1hZ2U=" },
                }),
            ).toBe(true);
            expect(
                Value.Check(createSurfaceRequestSchema, { type: request.type, name: request.name }),
            ).toBe(false);
            expect(
                Value.Check(createSurfaceRequestSchema, {
                    ...request,
                    artifactId: "artifact1",
                    botId: "bot1",
                    taskId: "task1",
                }),
            ).toBe(false);
            expect(
                Value.Check(createSurfaceRequestSchema, { ...request, creatorUserId: null }),
            ).toBe(false);
            expect(
                Value.Check(createSurfaceRequestSchema, {
                    ...request,
                    target: { state: "available" },
                }),
            ).toBe(false);
        }
    });

    it("carries live display fields and the target's independent version only when available", () => {
        const targets: SurfaceTarget[] = [
            {
                type: "artifact",
                state: "available",
                artifactId: "artifact1",
                name: "Live title",
                hasImage: true,
                version: nextVersion,
            },
            {
                type: "bot",
                state: "available",
                botId: "bot1",
                name: "Live name",
                hasImage: true,
                version: nextVersion,
            },
            {
                type: "task",
                state: "available",
                taskId: "task1",
                name: "Live task",
                hasImage: false,
                version: nextVersion,
            },
        ];
        for (const target of targets) {
            expect(Value.Check(surfaceTargetSchema, target)).toBe(true);
            expect(Value.Check(surfaceSchema, { ...surface, type: target.type, target })).toBe(
                true,
            );
            expect(Value.Check(surfaceTargetSchema, { ...target, name: undefined })).toBe(false);
            expect(Value.Check(surfaceTargetSchema, { ...target, version: undefined })).toBe(false);
            expect(
                Value.Check(surfaceTargetSchema, {
                    ...target,
                    artifactId: "artifact1",
                    botId: "bot1",
                    taskId: "task1",
                }),
            ).toBe(false);
        }
        expect(Value.Check(surfaceTargetSchema, { ...targets[2], hasImage: true })).toBe(false);
        expect(Value.Check(surfaceSchema, surface)).toBe(true);
        expect(surfaceSchema.required).not.toContain("target");
    });

    it("omits identities and display metadata for every unavailable target kind", () => {
        for (const type of ["artifact", "bot", "task"]) {
            const target = { type, state: "unavailable" };
            expect(Value.Check(surfaceTargetSchema, target)).toBe(true);
            expect(Value.Check(surfaceSchema, { ...surface, type, target })).toBe(true);
            for (const leaked of [
                { artifactId: "artifact1" },
                { botId: "bot1" },
                { taskId: "task1" },
                { name: "Private target name" },
                { hasImage: true },
                { version: nextVersion },
            ])
                expect(Value.Check(surfaceTargetSchema, { ...target, ...leaked })).toBe(false);
        }
    });

    it("keeps caller-relative target projections out of shared Surface creation events", () => {
        expect(Value.Check(surfaceCreatedPayloadSchema, { surface })).toBe(true);
        for (const target of [
            {
                type: "bot",
                state: "available",
                botId: "bot1",
                name: "Private name",
                hasImage: true,
                version,
            },
            { type: "bot", state: "unavailable" },
        ])
            expect(
                Value.Check(surfaceCreatedPayloadSchema, { surface: { ...surface, target } }),
            ).toBe(false);
    });

    it("creates references through the catalog and returns fresh target metadata even at the same Surface version", async () => {
        const sent: unknown[] = [];
        let reads = 0;
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                expect(input.toString()).toBe("http://agent.local/v0/surfaces");
                if (init?.method === "POST") {
                    sent.push(JSON.parse(init.body as string));
                    return new Response(JSON.stringify({ surface }), { status: 201 });
                }
                reads += 1;
                const target: SurfaceTarget =
                    reads === 1
                        ? {
                              type: "bot",
                              state: "available",
                              botId: "bot1",
                              name: "Renamed live bot",
                              hasImage: false,
                              version: nextVersion,
                          }
                        : { type: "bot", state: "unavailable" };
                return new Response(
                    JSON.stringify({ surfaces: [{ ...surface, target }], cursor: nextVersion }),
                    { status: 200 },
                );
            },
        });
        for (const request of requests) await client.createSurface(request);
        expect(sent).toEqual(requests);
        const first = (await client.listSurfaces()).surfaces[0]!;
        const second = (await client.listSurfaces()).surfaces[0]!;
        expect(first.version).toBe(second.version);
        expect(first.name).toBe("Stored fallback label");
        expect(first.target).toMatchObject({
            state: "available",
            name: "Renamed live bot",
            version: nextVersion,
        });
        expect(second.target).toEqual({ type: "bot", state: "unavailable" });
    });
});
