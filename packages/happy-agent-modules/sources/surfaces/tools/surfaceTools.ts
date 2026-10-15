import { createId } from "@paralleldrive/cuid2";
import {
    defineAgentTool,
    cuid2Schema,
    type AgentKV,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import {
    surfaceIdSchema,
    surfaceSchema,
    surfaceMemberSchema,
    todoSchema,
    todoStatusSchema,
    todoTextSchema,
    todoListScopeSchema,
    todoVersionListResponseSchema,
    surfaceNameSchema,
    surfaceDocumentSchema,
    surfaceDocumentTextSchema,
    surfaceDocumentVersionListResponseSchema,
    resourceVersionSchema,
} from "@slopus/happy-agent-client";
import type { SurfacesModule } from "../SurfacesModule.js";

const identity = { surfaceId: surfaceIdSchema, todoId: cuid2Schema };
const guard = { ...identity, version: resourceVersionSchema };
const page = {
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const textResult = (result: unknown) => [{ type: "text" as const, text: JSON.stringify(result) }];
const imagePath = Type.Optional(
    Type.String({
        minLength: 1,
        maxLength: 4096,
        pattern: "^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\u0000]*$",
    }),
);
const fromImage = (path: string | undefined) =>
    path === undefined ? "" : ` from image ${JSON.stringify(path)}`;
const referenceRules =
    "The name is the Surface's permanent label, shown when the target is unavailable; while available, people see the target's live name. A missing, deleted, or archived target is rejected as not found. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum) for the Surface's own picture.";
const imageAccess =
    "Access: shared data write and, when supplied, filesystem image read; outside-workspace and symlink targets require Full access";

/** Fixed common arrays; model providers never affect the Surface tool or permission contract. */
export function surfaceTools(surfaces: SurfacesModule, scope: AgentModuleScope, admin: boolean) {
    type ToolContext = Parameters<SurfacesModule["actor"]>[0];
    const actor = (ctx: ToolContext) => surfaces.actor(ctx, scope.agent.id, scope.kv);
    /** Replays reuse the creation's first identity and image bytes rather than rereading the file. */
    const creation = async (ctx: ToolContext, call: { kv: AgentKV }, path: string | undefined) => {
        await surfaces.requireAdmin(ctx, scope.agent.id);
        const id = await call.kv.getOrCreate(ctx, "surfaceId", createId);
        if (path === undefined) return { id };
        const data = await call.kv.getOrCreate(ctx, "image", () =>
            surfaces.imageFromPath(ctx, scope.agent.id, path),
        );
        return { id, image: { data } };
    };
    const ordinary = [
        defineAgentTool({
            name: "list_surfaces",
            defer: true,
            capabilities: ["Find shared Surfaces and their members."],
            searchKeywords: ["list surfaces", "shared todo lists", "sidebar members"],
            description:
                "List shared Surface instances, their IDs, names, types, and joined people. Artifact, bot, and task Surfaces include their target's live name and ID while it is available, or an unavailable state without them. Each todo or document tool requires a Surface ID. Results are paged.",
            parameters: Type.Object(page, { additionalProperties: false }),
            returnType: Type.Object({
                surfaces: Type.Array(surfaceSchema),
                nextOffset: Type.Union([Type.Integer(), Type.Null()]),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const all = await surfaces.list(ctx);
                const start = input.offset ?? 0;
                const end = start + (input.limit ?? 20);
                return {
                    surfaces: all.slice(start, end),
                    nextOffset: end < all.length ? end : null,
                };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_todos",
            defer: true,
            capabilities: ["Read active, completed, or deleted todos in a Surface."],
            searchKeywords: ["list todos", "checklist items", "completed todos", "deleted todos"],
            description:
                "List todos in one Surface, active by default. Active text starting with exact '# ' is a section heading, not an outstanding task; exclude headings from task counts. Do not trim text before checking that prefix. Use completed, deleted, or all to find older items. Keep returned versions for guarded edits. Results are paged.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema, scope: Type.Optional(todoListScopeSchema), ...page },
                { additionalProperties: false },
            ),
            returnType: Type.Object({
                todos: Type.Array(todoSchema),
                nextOffset: Type.Union([Type.Integer(), Type.Null()]),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const all = await surfaces.listTodos(ctx, input.surfaceId, input.scope);
                const start = input.offset ?? 0;
                const end = start + (input.limit ?? 20);
                return { todos: all.slice(start, end), nextOffset: end < all.length ? end : null };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_todo",
            defer: true,
            capabilities: ["Add a todo to a shared Surface."],
            searchKeywords: ["create todo", "add checklist item", "new reminder"],
            description:
                "Add a plain-text todo at the top of one shared Surface. For a section heading, start the text with exact '# ' (hash and space); it remains an ordinary ordered todo without a checkbox. Explicitly supply authorUserId as a local Happy user ID, or null for no attribution; only null is allowed in standalone mode. The author is immutable and separate from the revision's audit actor. This never creates a chat or joins anyone to the Surface.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    text: todoTextSchema,
                    authorUserId: surfaceMemberSchema.properties.userId,
                },
                { additionalProperties: false },
            ),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId }) =>
                `adding a todo to shared Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, input, call) =>
                surfaces.createTodo(
                    ctx,
                    input.surfaceId,
                    { text: input.text, id: await call.kv.getOrCreate(ctx, "todoId", createId) },
                    await actor(ctx),
                    input.authorUserId,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "update_todo",
            defer: true,
            capabilities: ["Change a todo's text or active, completed, or deleted state."],
            searchKeywords: ["edit todo", "complete todo", "uncomplete todo", "change todo state"],
            description:
                "Edit text or status (active, completed, deleted) with the current version. Returning an inactive todo to active appends it to the list. To apply a historical state, read its revision and supply the desired fields here; use reorder_todo for placement. Conflicts require a fresh read.",
            parameters: Type.Object(
                {
                    ...guard,
                    text: Type.Optional(todoTextSchema),
                    status: Type.Optional(todoStatusSchema),
                },
                { additionalProperties: false },
            ),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, todoId }) =>
                `editing todo ${JSON.stringify(todoId)} in shared Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, { surfaceId, todoId, version, ...edit }) =>
                surfaces.mutateTodo(
                    ctx,
                    surfaceId,
                    todoId,
                    version,
                    "update",
                    edit,
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "reorder_todo",
            defer: true,
            capabilities: ["Move an active todo within its Surface list."],
            searchKeywords: ["reorder todo", "move checklist item", "todo position"],
            description:
                "Move an active todo after another active todo in the same Surface, or first with afterId null. Completed and deleted todos cannot be reordered.",
            parameters: Type.Object(
                { ...guard, afterId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, todoId }) =>
                `moving todo ${JSON.stringify(todoId)} in shared Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, input) =>
                surfaces.mutateTodo(
                    ctx,
                    input.surfaceId,
                    input.todoId,
                    input.version,
                    "reorder",
                    { afterId: input.afterId },
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "delete_todo",
            defer: true,
            capabilities: ["Delete a todo while preserving its permanent history."],
            searchKeywords: ["delete todo", "remove checklist item"],
            description:
                "Delete a todo from one Surface. Its text and every revision remain permanently recoverable.",
            parameters: Type.Object(guard, { additionalProperties: false }),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, todoId }) =>
                `deleting todo ${JSON.stringify(todoId)} from shared Surface ${JSON.stringify(surfaceId)} while preserving its history. Access: shared data write`,
            execute: async (ctx, input) =>
                surfaces.mutateTodo(
                    ctx,
                    input.surfaceId,
                    input.todoId,
                    input.version,
                    "delete",
                    {},
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_todo_versions",
            defer: true,
            capabilities: ["Read a todo's permanent revisions and their authors."],
            searchKeywords: ["todo history", "todo versions", "previous todo state", "todo author"],
            description:
                "Read a bounded page of a todo's permanent full revisions and their actors, oldest first. Continue with nextAfterVersion.",
            parameters: Type.Object(
                {
                    ...identity,
                    afterVersion: Type.Optional(resourceVersionSchema),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
                },
                { additionalProperties: false },
            ),
            returnType: todoVersionListResponseSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                surfaces.versions(
                    ctx,
                    input.surfaceId,
                    input.todoId,
                    input.afterVersion,
                    input.limit ?? 10,
                ),
            toLLM: textResult,
        }),
    ];
    const documents = [
        defineAgentTool({
            name: "read_document",
            defer: true,
            capabilities: ["Read a shared Surface's Markdown document or a permanent revision."],
            searchKeywords: ["read document", "surface markdown", "previous document text"],
            description:
                "Read a document Surface's current Markdown and version, or the immutable snapshot at an optional historical version. Text is preserved verbatim. Keep the current version for a guarded update; reading history does not change the document.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema, version: Type.Optional(resourceVersionSchema) },
                { additionalProperties: false },
            ),
            returnType: surfaceDocumentSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                input.version === undefined
                    ? surfaces.getDocument(ctx, input.surfaceId)
                    : (await surfaces.getDocumentVersion(ctx, input.surfaceId, input.version))
                          .document,
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "update_document",
            defer: true,
            capabilities: [
                "Replace a shared document's Markdown while preserving permanent history.",
            ],
            searchKeywords: [
                "update document",
                "edit markdown",
                "clear shared document",
                "restore document revision",
            ],
            description:
                "Replace a document Surface's entire Markdown using its current version. Empty text clears content without deleting history. Identical text is a no-op only when the version matches. On conflict, read the latest document before editing. To restore a revision, read its text and write it with the current version.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    version: resourceVersionSchema,
                    text: surfaceDocumentTextSchema,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceDocumentSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId }) =>
                `replacing the shared document in Surface ${JSON.stringify(surfaceId)} while preserving history. Access: shared data write; no filesystem access`,
            execute: async (ctx, input) =>
                surfaces.updateDocument(
                    ctx,
                    input.surfaceId,
                    input.version,
                    { text: input.text },
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_document_versions",
            defer: true,
            capabilities: ["Read a shared document's permanent revision summaries and authors."],
            searchKeywords: ["document history", "document versions", "markdown revision authors"],
            description:
                "Read permanent document revision summaries, oldest first, without loading Markdown text. Returns up to 20 entries, default 10. Continue with nextAfterVersion; use read_document with a selected version for its text.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    afterVersion: Type.Optional(resourceVersionSchema),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
                },
                { additionalProperties: false },
            ),
            returnType: surfaceDocumentVersionListResponseSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                surfaces.documentVersions(
                    ctx,
                    input.surfaceId,
                    input.afterVersion,
                    input.limit ?? 10,
                ),
            toLLM: textResult,
        }),
    ];
    const administration = [
        defineAgentTool({
            name: "create_todo_surface",
            defer: true,
            capabilities: ["Create a named shared todo-list Surface as an admin bot."],
            searchKeywords: ["create todo surface", "new shared todo list", "todo list image"],
            description:
                "Admin bots only: create a distinct named shared todo-list Surface. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is immutable. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared todo Surface${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "todo",
                        name: input.name,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_document_surface",
            defer: true,
            capabilities: ["Create a named shared Markdown document Surface as an admin bot."],
            searchKeywords: ["create document surface", "new shared markdown", "document image"],
            description:
                "Admin bots only: create a document Surface with optional initial Markdown, empty by default. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is the immutable author and joins their sidebar; null joins nobody in team mode and the local person in standalone mode. Revision audit identity remains the actual caller. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    text: Type.Optional(surfaceDocumentTextSchema),
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Markdown document Surface${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "document",
                        name: input.name,
                        ...(input.text === undefined ? {} : { text: input.text }),
                    },
                    input.creatorUserId,
                    scope.agent.id,
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_artifact_surface",
            defer: true,
            capabilities: ["Create a Surface that points at an existing artifact as an admin bot."],
            searchKeywords: ["artifact surface", "pin artifact to sidebar", "artifact reference"],
            description: `Admin bots only: create a Surface pointing at one existing, undeleted artifact so people can keep it in their sidebar. It neither copies nor changes the artifact. ${referenceRules}`,
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    artifactId: cuid2Schema,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Surface referencing artifact ${JSON.stringify(input.artifactId)}${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "artifact",
                        name: input.name,
                        artifactId: input.artifactId,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_bot_surface",
            defer: true,
            capabilities: ["Create a Surface that points at an existing bot as an admin bot."],
            searchKeywords: ["bot surface", "pin bot to sidebar", "bot reference"],
            description: `Admin bots only: create a Surface pointing at one existing, active bot so people can keep it in their sidebar. Opening it shows that bot's existing conversation; it grants no access and changes nothing about the bot. ${referenceRules}`,
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    botId: cuid2Schema,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Surface referencing bot ${JSON.stringify(input.botId)}${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "bot",
                        name: input.name,
                        botId: input.botId,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_task_surface",
            defer: true,
            capabilities: ["Create a Surface that points at an existing task as an admin bot."],
            searchKeywords: ["task surface", "pin task to sidebar", "task reference"],
            description: `Admin bots only: create a Surface pointing at one existing, active task so people can keep it in their sidebar. Opening it shows that task's existing conversation; it never joins anyone to the task or changes who may archive it. ${referenceRules}`,
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    taskId: cuid2Schema,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Surface referencing task ${JSON.stringify(input.taskId)}${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "task",
                        name: input.name,
                        taskId: input.taskId,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_separator_surface",
            defer: true,
            capabilities: ["Create a named sidebar separator Surface as an admin bot."],
            searchKeywords: ["create separator surface", "sidebar section", "named divider"],
            description:
                "Admin bots only: create a named, contentless sidebar separator. It does not contain or own other Surfaces and has no image. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode.",
            parameters: Type.Object(
                { name: surfaceNameSchema, creatorUserId: surfaceMemberSchema.properties.userId },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ name }) =>
                `creating sidebar separator Surface ${JSON.stringify(name)}. Access: shared data write; no filesystem access`,
            execute: async (ctx, input, call) => {
                await surfaces.requireAdmin(ctx, scope.agent.id);
                return surfaces.create(
                    ctx,
                    {
                        type: "separator",
                        name: input.name,
                        id: await call.kv.getOrCreate(ctx, "surfaceId", createId),
                    },
                    input.creatorUserId,
                    scope.agent.id,
                );
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "add_surface_user",
            defer: true,
            capabilities: ["Add a person to a Surface as an admin bot."],
            searchKeywords: ["add surface member", "join shared list", "surface sidebar"],
            description:
                "Admin bots only: add an existing user to a Surface, appending it to their own sidebar. Use null for the standalone person. Existing members keep their order.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema, userId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, userId }) =>
                `adding ${userId === null ? "the standalone person" : `user ${JSON.stringify(userId)}`} to shared Surface ${JSON.stringify(surfaceId)}. Access: shared membership and sidebar write`,
            execute: async (ctx, input) => {
                await surfaces.requireAdmin(ctx, scope.agent.id);
                return surfaces.changeMember(ctx, input.surfaceId, input.userId, "join");
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "remove_surface_user",
            defer: true,
            capabilities: ["Remove a person's Surface membership as an admin bot."],
            searchKeywords: ["remove surface member", "leave shared list", "remove sidebar list"],
            description:
                "Admin bots only: remove a user's Surface from their sidebar. Todos, revisions, and all other users' memberships stay intact.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema, userId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, userId }) =>
                `removing ${userId === null ? "the standalone person" : `user ${JSON.stringify(userId)}`} from shared Surface ${JSON.stringify(surfaceId)} without deleting its data. Access: shared membership and sidebar write`,
            execute: async (ctx, input) => {
                await surfaces.requireAdmin(ctx, scope.agent.id);
                return surfaces.changeMember(ctx, input.surfaceId, input.userId, "leave");
            },
            toLLM: textResult,
        }),
    ];
    return admin ? [...ordinary, ...documents, ...administration] : [...ordinary, ...documents];
}
