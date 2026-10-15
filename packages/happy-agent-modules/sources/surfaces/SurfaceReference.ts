import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

/** The immutable entity a reference Surface points at, stored apart from the shared record. */
export const surfaceReferenceSchema = Type.Union([
    Type.Object(
        { type: Type.Literal("artifact"), artifactId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object({ type: Type.Literal("bot"), botId: cuid2Schema }, { additionalProperties: false }),
    Type.Object(
        { type: Type.Literal("task"), taskId: cuid2Schema },
        { additionalProperties: false },
    ),
]);
export type SurfaceReference = Static<typeof surfaceReferenceSchema>;
