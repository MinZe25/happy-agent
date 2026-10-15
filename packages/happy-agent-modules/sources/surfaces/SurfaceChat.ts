import { cuid2Schema } from "@slopus/happy-agent-base";
import { mutationIdSchema, surfaceIdSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/**
 * A Surface's one shared conversation and its dedicated folder. The identities and path are
 * reserved once, before any filesystem work, and never change; the Surface names the agent only
 * after the folder exists and the agent commits.
 */
export const surfaceChatSchema = Type.Object(
    {
        surfaceId: surfaceIdSchema,
        agentId: cuid2Schema,
        workspaceId: cuid2Schema,
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        runnerId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" })),
        mutationId: Type.Optional(mutationIdSchema),
        reservedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type SurfaceChat = Static<typeof surfaceChatSchema>;
