/** Predefined shared features and each person's independent sidebar subscriptions. */
import { type Static, Type } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import { userIdSchema } from "./userId.js";

/** Each list uses the daemon generator's exact 24-character CUID2 format. */
export const surfaceIdSchema = Type.String({
    minLength: 24,
    maxLength: 24,
    pattern: "^[a-z][a-z0-9]{23}$",
});
export type SurfaceId = Static<typeof surfaceIdSchema>;

/** The same decimal fractional keys used by other installation catalogs. */
export const surfaceOrderKeySchema = Type.String({ pattern: "^[0-9]*[1-9]$" });

/** Nested in its Surface; the key orders that Surface only in this person's sidebar. */
export const surfaceMemberSchema = Type.Object({
    joinedAt: timestampSchema,
    orderKey: surfaceOrderKeySchema,
    /** Existing standalone identity convention; the member itself is never null. */
    userId: Nullable(userIdSchema),
});
export type SurfaceMember = Static<typeof surfaceMemberSchema>;

export const surfaceSchema = Type.Object({
    /** Immutable creator; null means unattributed or standalone. Older daemons omit it. */
    creatorUserId: Type.Optional(Nullable(userIdSchema)),
    id: surfaceIdSchema,
    image: Nullable(Type.Object({ thumbhash: Type.String() })),
    type: Type.String({ minLength: 1 }),
    members: Type.Array(surfaceMemberSchema),
    name: Type.String({ minLength: 1, maxLength: 256, pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$" }),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type Surface = Static<typeof surfaceSchema>;

export const surfaceListResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    surfaces: Type.Array(surfaceSchema),
});
export type SurfaceListResponse = Static<typeof surfaceListResponseSchema>;

export const surfaceResponseSchema = Type.Object({
    surface: surfaceSchema,
});
export type SurfaceResponse = Static<typeof surfaceResponseSchema>;

const surfaceCreationFields = {
    id: Type.Optional(surfaceIdSchema),
    name: surfaceSchema.properties.name,
    mutationId: Type.Optional(mutationIdSchema),
};

const surfaceImageInputSchema = Type.Object(
    { data: Type.String({ minLength: 1, maxLength: 11_184_812 }) },
    { additionalProperties: false },
);

/** Markdown is preserved verbatim, including an empty document; length is in UTF-16 units. */
export const surfaceDocumentTextSchema = Type.String({
    maxLength: 262_144,
    pattern: "^[^\\u0000]*$",
});

export const createTodoSurfaceRequestSchema = Type.Object(
    {
        ...surfaceCreationFields,
        image: Type.Optional(surfaceImageInputSchema),
        type: Type.Literal("todo"),
    },
    { additionalProperties: false },
);
export const createSeparatorSurfaceRequestSchema = Type.Object(
    { ...surfaceCreationFields, type: Type.Literal("separator") },
    { additionalProperties: false },
);
export const createDocumentSurfaceRequestSchema = Type.Object(
    {
        ...surfaceCreationFields,
        image: Type.Optional(surfaceImageInputSchema),
        text: Type.Optional(surfaceDocumentTextSchema),
        type: Type.Literal("document"),
    },
    { additionalProperties: false },
);
export const createSurfaceRequestSchema = Type.Union([
    createTodoSurfaceRequestSchema,
    createSeparatorSurfaceRequestSchema,
    createDocumentSurfaceRequestSchema,
]);
export type CreateSurfaceRequest = Static<typeof createSurfaceRequestSchema>;

export const surfaceMemberRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type SurfaceMemberRequest = Static<typeof surfaceMemberRequestSchema>;

export const reorderSurfaceRequestSchema = Type.Object(
    { afterId: Nullable(surfaceIdSchema), mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type ReorderSurfaceRequest = Static<typeof reorderSurfaceRequestSchema>;

/** Active text starting with exact `# ` is a section heading; stored text is never trimmed. */
export const todoTextSchema = Type.String({
    minLength: 1,
    maxLength: 10_000,
    pattern: "^(?=[\\s\\S]*\\S)[^\\x00-\\x08\\x0b-\\x1f\\x7f]+$",
});

const todoFields = {
    /** Immutable author, distinct from revision actors. Older daemons omit it. */
    authorUserId: Type.Optional(Nullable(userIdSchema)),
    createdAt: timestampSchema,
    id: cuid2Schema,
    surfaceId: surfaceIdSchema,
    text: todoTextSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

/** Active items alone have an order key. Deletions retain their completion timestamp. */
export const todoSchema = Type.Union([
    Type.Object({
        ...todoFields,
        completedAt: Type.Null(),
        deletedAt: Type.Null(),
        orderKey: surfaceOrderKeySchema,
        status: Type.Literal("active"),
    }),
    Type.Object({
        ...todoFields,
        completedAt: timestampSchema,
        deletedAt: Type.Null(),
        orderKey: Type.Null(),
        status: Type.Literal("completed"),
    }),
    Type.Object({
        ...todoFields,
        completedAt: Nullable(timestampSchema),
        deletedAt: timestampSchema,
        orderKey: Type.Null(),
        status: Type.Literal("deleted"),
    }),
]);
export type Todo = Static<typeof todoSchema>;

export const todoStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("completed"),
    Type.Literal("deleted"),
]);

export const todoListScopeSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("completed"),
    Type.Literal("deleted"),
    Type.Literal("all"),
]);
export type TodoListScope = Static<typeof todoListScopeSchema>;

export const todoListResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    todos: Type.Array(todoSchema),
});
export type TodoListResponse = Static<typeof todoListResponseSchema>;

export const todoResponseSchema = Type.Object({ todo: todoSchema });
export type TodoResponse = Static<typeof todoResponseSchema>;

/** Audit identity comes from trusted API or tool execution context, never the body. */
const surfaceRevisionActorSchema = Type.Object({
    agentId: Nullable(cuid2Schema),
    userId: Nullable(userIdSchema),
});
const surfaceRevisionSourceSchema = Type.Union([Type.Literal("api"), Type.Literal("tool")]);
export const todoRevisionSchema = Type.Object({
    actor: surfaceRevisionActorSchema,
    source: surfaceRevisionSourceSchema,
    todo: todoSchema,
});
export type TodoRevision = Static<typeof todoRevisionSchema>;

export const todoVersionListResponseSchema = Type.Object({
    nextAfterVersion: Nullable(resourceVersionSchema),
    versions: Type.Array(todoRevisionSchema),
});
export type TodoVersionListResponse = Static<typeof todoVersionListResponseSchema>;

export const todoVersionResponseSchema = Type.Object({ revision: todoRevisionSchema });
export type TodoVersionResponse = Static<typeof todoVersionResponseSchema>;

export const createTodoRequestSchema = Type.Object(
    {
        id: Type.Optional(cuid2Schema),
        mutationId: Type.Optional(mutationIdSchema),
        text: todoTextSchema,
    },
    { additionalProperties: false },
);
export type CreateTodoRequest = Static<typeof createTodoRequestSchema>;

/** At least one editable field must be present; a mutation echo alone is not an edit. */
export const updateTodoRequestSchema = Type.Union([
    Type.Object(
        {
            status: Type.Optional(todoStatusSchema),
            mutationId: Type.Optional(mutationIdSchema),
            text: todoTextSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            status: todoStatusSchema,
            mutationId: Type.Optional(mutationIdSchema),
            text: Type.Optional(todoTextSchema),
        },
        { additionalProperties: false },
    ),
]);
export type UpdateTodoRequest = Static<typeof updateTodoRequestSchema>;

export const reorderTodoRequestSchema = Type.Object(
    { afterId: Nullable(cuid2Schema), mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type ReorderTodoRequest = Static<typeof reorderTodoRequestSchema>;

/** Delete accepts this optional echo-only body. */
export const todoMutationRequestSchema = surfaceMemberRequestSchema;
export type TodoMutationRequest = Static<typeof todoMutationRequestSchema>;

/** A document's content version is independent of its catalog Surface version. */
export const surfaceDocumentSchema = Type.Object({
    authorUserId: Nullable(userIdSchema),
    createdAt: timestampSchema,
    lastEditorUserId: Nullable(userIdSchema),
    surfaceId: surfaceIdSchema,
    text: surfaceDocumentTextSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type SurfaceDocument = Static<typeof surfaceDocumentSchema>;

export const surfaceDocumentResponseSchema = Type.Object({ document: surfaceDocumentSchema });
export type SurfaceDocumentResponse = Static<typeof surfaceDocumentResponseSchema>;

export const surfaceDocumentSnapshotResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    document: surfaceDocumentSchema,
});
export type SurfaceDocumentSnapshotResponse = Static<typeof surfaceDocumentSnapshotResponseSchema>;

export const updateSurfaceDocumentRequestSchema = Type.Object(
    { text: surfaceDocumentTextSchema, mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type UpdateSurfaceDocumentRequest = Static<typeof updateSurfaceDocumentRequestSchema>;

export const surfaceDocumentRevisionSchema = Type.Object({
    actor: surfaceRevisionActorSchema,
    document: surfaceDocumentSchema,
    /** Immutable request correlation; null when not supplied, absent on older daemons. */
    mutationId: Type.Optional(Nullable(mutationIdSchema)),
    source: surfaceRevisionSourceSchema,
});
export type SurfaceDocumentRevision = Static<typeof surfaceDocumentRevisionSchema>;

/** History pages carry only immutable metadata; fetch one revision to read its text. */
export const surfaceDocumentVersionSummarySchema = Type.Object({
    actor: surfaceRevisionActorSchema,
    /** Identifies a committed save after a lost response; never a deduplication key. */
    mutationId: surfaceDocumentRevisionSchema.properties.mutationId,
    source: surfaceRevisionSourceSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type SurfaceDocumentVersionSummary = Static<typeof surfaceDocumentVersionSummarySchema>;

export const surfaceDocumentVersionListResponseSchema = Type.Object({
    nextAfterVersion: Nullable(resourceVersionSchema),
    versions: Type.Array(surfaceDocumentVersionSummarySchema),
});
export type SurfaceDocumentVersionListResponse = Static<
    typeof surfaceDocumentVersionListResponseSchema
>;

export const surfaceDocumentVersionResponseSchema = Type.Object({
    revision: surfaceDocumentRevisionSchema,
});
export type SurfaceDocumentVersionResponse = Static<typeof surfaceDocumentVersionResponseSchema>;
