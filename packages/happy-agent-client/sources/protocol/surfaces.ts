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

/** Each list is an independent CUID2-identified instance. */
export const surfaceIdSchema = Type.String({ pattern: "^[a-z][a-z0-9]{1,31}$" });
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

export const createSurfaceRequestSchema = Type.Object(
    {
        id: Type.Optional(surfaceIdSchema),
        image: Type.Optional(
            Type.Object(
                { data: Type.String({ minLength: 1, maxLength: 11_184_812 }) },
                { additionalProperties: false },
            ),
        ),
        type: Type.Literal("todo"),
        name: surfaceSchema.properties.name,
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);
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

export const todoTextSchema = Type.String({
    minLength: 1,
    maxLength: 10_000,
    pattern: "^(?=[\\s\\S]*\\S)[^\\x00-\\x08\\x0b-\\x1f\\x7f]+$",
});

const todoFields = {
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
export const todoRevisionSchema = Type.Object({
    actor: Type.Object({ agentId: Nullable(cuid2Schema), userId: Nullable(userIdSchema) }),
    source: Type.Union([Type.Literal("api"), Type.Literal("tool")]),
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
