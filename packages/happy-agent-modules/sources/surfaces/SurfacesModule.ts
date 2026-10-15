import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    cuid2Schema,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import {
    createTodoSurfaceRequestSchema,
    createSeparatorSurfaceRequestSchema,
    createDocumentSurfaceRequestSchema,
    createArtifactSurfaceRequestSchema,
    createBotSurfaceRequestSchema,
    createTaskSurfaceRequestSchema,
    surfaceDocumentSchema,
    surfaceDocumentRevisionSchema,
    surfaceDocumentVersionSummarySchema,
    surfaceDocumentUpdatedPayloadSchema,
    updateSurfaceDocumentRequestSchema,
    createTodoRequestSchema,
    surfaceSchema,
    surfaceMemberSchema,
    surfaceIdSchema,
    todoSchema,
    todoRevisionSchema,
    updateTodoRequestSchema,
    todoListScopeSchema,
    surfaceCreatedPayloadSchema,
    surfaceUpdatedPayloadSchema,
    todoCreatedPayloadSchema,
    todoUpdatedPayloadSchema,
    resourceVersionSchema,
    type CreateSurfaceRequest,
    type CreateTodoRequest,
    type UpdateTodoRequest,
    type Surface,
    type SurfaceTarget,
    type Todo,
    type TodoRevision,
    type TodoListScope,
    type SurfaceDocument,
    type SurfaceDocumentRevision,
    type SurfaceDocumentVersionListResponse,
    type UpdateSurfaceDocumentRequest,
} from "@slopus/happy-agent-client";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { TeamModule } from "../team/index.js";
import { BotsModule } from "../bots/index.js";
import { TasksModule } from "../tasks/index.js";
import { ArtifactsModule } from "../artifacts/index.js";
import { ComputeModule } from "../compute/index.js";
import { apiResourceVersion } from "../utils/apiResourceVersion.js";
import { isUserOriginMetadata } from "../impl/messageOrigin.js";
import { SurfacesPersistence, surfacesMigrations } from "./persistence/SurfacesPersistence.js";
import { SurfaceError } from "./SurfaceError.js";
import { SurfaceDocumentConflictError } from "./SurfaceDocumentConflictError.js";
import { compareStrings, surfaceOrderKey } from "./impl/surfaceOrderKey.js";
import {
    normalizeManagedImage,
    MAX_MANAGED_IMAGE_BYTES as MAX_SURFACE_IMAGE_BYTES,
} from "../impl/images/normalizeManagedImage.js";
import { surfaceImageAssetSchema, type SurfaceImageAsset } from "./SurfaceImageAsset.js";
import { surfaceReferenceSchema, type SurfaceReference } from "./SurfaceReference.js";
import { surfaceTools } from "./tools/surfaceTools.js";

const eventSchema = Type.Union([
    Type.Object({ type: Type.Literal("surface.created"), payload: surfaceCreatedPayloadSchema }),
    Type.Object({ type: Type.Literal("surface.updated"), payload: surfaceUpdatedPayloadSchema }),
    Type.Object({ type: Type.Literal("todo.created"), payload: todoCreatedPayloadSchema }),
    Type.Object({ type: Type.Literal("todo.updated"), payload: todoUpdatedPayloadSchema }),
    Type.Object({
        type: Type.Literal("surface.document.updated"),
        payload: surfaceDocumentUpdatedPayloadSchema,
    }),
]);
export type SurfaceEvent = Static<typeof eventSchema>;
type Listener = (ctx: Context, event: SurfaceEvent) => void | Promise<void>;
export type SurfaceActor = TodoRevision["actor"];
const supportedCreationSchema = Type.Union([
    createTodoSurfaceRequestSchema,
    createSeparatorSurfaceRequestSchema,
    createDocumentSurfaceRequestSchema,
    createArtifactSurfaceRequestSchema,
    createBotSurfaceRequestSchema,
    createTaskSurfaceRequestSchema,
]);
const documentHistoryCursorSchema = Type.String({
    minLength: 36,
    maxLength: 36,
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

/** Shared list instances. Every decision and revision commits under the database transaction lock. */
export class SurfacesModule implements AgentModule {
    readonly name = "surfaces";
    readonly migrations = surfacesMigrations;
    readonly #listeners = new Set<Listener>();
    readonly #transactional = new Set<Listener>();
    #store!: SurfacesPersistence;
    #kv!: AgentKV;
    constructor(
        readonly durable: DurableFunctionsModule,
        readonly team: TeamModule,
        readonly bots: BotsModule,
        readonly tasks: TasksModule,
        readonly artifacts: ArtifactsModule,
        readonly compute: ComputeModule,
    ) {
        durable.register({
            name: "surfaces.notify",
            argumentsSchema: eventSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                for (const listener of this.#listeners) await listener(ctx, call.arguments);
                return null;
            },
        });
    }
    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        this.#store = new SurfacesPersistence(agentDatabase(ctx)!);
        this.#kv = this.#store.kv();
        return {
            tools: async (toolCtx, scope) =>
                surfaceTools(this, scope, await this.isAdmin(toolCtx, scope.agent.id)),
            messageAcceptedTransact: async (hookCtx, scope, accepted) => {
                if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata))
                    return;
                const owner = accepted.metadata?.["userId"];
                await scope.kv.write(
                    hookCtx,
                    "owner",
                    Value.Check(cuid2Schema, owner) ? owner : null,
                );
            },
        };
    };
    onEvent(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
    onEventTransactional(listener: Listener): () => void {
        this.#transactional.add(listener);
        return () => {
            this.#transactional.delete(listener);
        };
    }
    async owner(ctx: Context): Promise<string | null> {
        if (!this.team.enabled) return null;
        const owner = await this.team.currentUser(ctx);
        if (owner === undefined)
            throw new SurfaceError("forbidden", "Sign in and complete your profile first.");
        return owner.id;
    }
    async actor(ctx: Context, agentId: string, kv: AgentKV): Promise<SurfaceActor> {
        const owner = await kv.read(ctx, "owner");
        return {
            agentId,
            userId: this.team.enabled && Value.Check(cuid2Schema, owner) ? owner : null,
        };
    }
    async isAdmin(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }
    async requireAdmin(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.isAdmin(ctx, agentId)))
            throw new SurfaceError(
                "forbidden",
                "Only an active admin bot can manage Surfaces or their users.",
            );
    }
    async shouldElevateImage(ctx: Context, agentId: string, path?: string): Promise<boolean> {
        if (path === undefined) return false;
        const compute = await this.compute.resolve(ctx, agentId);
        return (
            compute === undefined ||
            (await this.compute.shouldReviewPath(ctx, compute, path, { write: false }))
        );
    }
    async imageFromPath(ctx: Context, agentId: string, path: string): Promise<string> {
        await this.requireAdmin(ctx, agentId);
        const compute = await this.compute.resolve(ctx, agentId);
        if (compute === undefined)
            throw new SurfaceError("invalid_request", "The agent filesystem is unavailable.");
        const permissions = this.compute.permissionsForContext(ctx);
        const facts = await compute.fs.stat(permissions, path);
        if (!facts.isFile || facts.size > MAX_SURFACE_IMAGE_BYTES)
            throw new SurfaceError(
                "invalid_request",
                "The Surface image must be a file no larger than 8 MiB.",
            );
        return Buffer.from(
            await compute.fs.readFileBuffer(permissions, path, {
                maxBytes: MAX_SURFACE_IMAGE_BYTES,
            }),
        ).toString("base64");
    }
    /** The catalog as its caller sees it, with each reference target resolved for that caller. */
    async list(ctx: Context): Promise<Surface[]> {
        return ctx.inTx(async (tx) =>
            Promise.all((await this.#stored(tx)).map((surface) => this.#present(tx, surface))),
        );
    }
    async create(
        ctx: Context,
        request: CreateSurfaceRequest,
        creatorUserId: string | null,
        adminAgentId?: string,
        actor?: SurfaceActor,
    ): Promise<Surface> {
        const input = checked(supportedCreationSchema, request);
        const reference = referenceFor(input);
        if (reference !== undefined) checked(surfaceReferenceSchema, reference);
        let image: SurfaceImageAsset | null = null;
        if (input.type !== "separator" && input.image !== undefined) {
            try {
                const normalized = await normalizeManagedImage(
                    Buffer.from(input.image.data, "base64"),
                );
                image = {
                    data: Buffer.from(normalized.bytes).toString("base64"),
                    etag: normalized.etag,
                    thumbhash: normalized.thumbhash,
                };
            } catch (error) {
                throw new SurfaceError(
                    "invalid_request",
                    error instanceof Error ? error.message : "The Surface image is invalid.",
                );
            }
        }
        return ctx.inTx(async (tx) => {
            if (adminAgentId !== undefined) await this.requireAdmin(tx, adminAgentId);
            await this.#validateUser(tx, creatorUserId);
            const id = input.id ?? createId();
            const old = await this.#kv.read(tx, `surface.${id}`);
            if (old !== undefined) return this.#present(tx, readSurface(old));
            if (
                reference !== undefined &&
                (await this.#resolve(tx, reference)).state === "unavailable"
            )
                throw new SurfaceError("not_found", "The referenced item was not found.");
            const now = Date.now();
            const surface = {
                id,
                type: input.type,
                name: input.name,
                creatorUserId,
                image: image === null ? null : { thumbhash: image.thumbhash },
                members:
                    this.team.enabled && creatorUserId === null
                        ? []
                        : [
                              {
                                  userId: creatorUserId,
                                  joinedAt: now,
                                  orderKey: await this.#memberTail(tx, creatorUserId),
                              },
                          ],
                updatedAt: now,
                version: createUuidV7Factory()(),
            } satisfies Surface;
            await this.#kv.write(tx, `surface.${id}`, surface);
            if (image !== null) await this.#kv.write(tx, `image.${id}`, image);
            if (reference !== undefined) await this.#kv.write(tx, `reference.${id}`, reference);
            if (input.type === "document") {
                const revisionActor = actor ?? {
                    userId: await this.owner(tx),
                    agentId: adminAgentId ?? null,
                };
                await this.#saveDocument(
                    tx,
                    {
                        surfaceId: id,
                        text: input.text ?? "",
                        authorUserId: creatorUserId,
                        lastEditorUserId: revisionActor.userId,
                        createdAt: now,
                        updatedAt: now,
                        version: createUuidV7Factory(Date.now, surface.version)(),
                    },
                    revisionActor,
                    input.mutationId,
                );
            }
            await this.#event(tx, {
                type: "surface.created",
                payload: { surface, ...echo(input.mutationId) },
            });
            return this.#present(tx, surface);
        });
    }
    async image(ctx: Context, id: string): Promise<SurfaceImageAsset> {
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, id);
            const image = await this.#kv.read(tx, `image.${id}`);
            if (image === undefined)
                throw new SurfaceError("not_found", "This Surface has no image.");
            return checked(surfaceImageAssetSchema, image);
        });
    }
    async changeMember(
        ctx: Context,
        id: string,
        userId: string | null,
        action: "join" | "leave" | "reorder",
        afterId: string | null = null,
        mutationId?: string,
    ): Promise<Surface> {
        return ctx.inTx(async (tx) => {
            await this.#validateUser(tx, userId);
            if (this.team.enabled && userId === null)
                throw new SurfaceError("not_found", "The Surface user was not found.");
            const current = await this.#surface(tx, id);
            const member = current.members.find((m) => m.userId === userId);
            if (
                (action === "join" && member !== undefined) ||
                (action === "leave" && member === undefined)
            )
                return this.#present(tx, current);
            let members = [...current.members];
            if (action === "join")
                members.push({
                    userId,
                    joinedAt: Date.now(),
                    orderKey: await this.#memberTail(tx, userId),
                });
            else if (action === "leave") members = members.filter((m) => m.userId !== userId);
            else {
                if (member === undefined)
                    throw new SurfaceError("conflict", "Join this Surface before reordering it.");
                const own = (await this.#stored(tx))
                    .flatMap((s) =>
                        s.members
                            .filter((m) => m.userId === userId)
                            .map((m) => ({ id: s.id, orderKey: m.orderKey })),
                    )
                    .sort(byOrder);
                const key = reorderedKey(own, id, afterId);
                if (key === undefined) return this.#present(tx, current);
                members = members.map((m) => (m.userId === userId ? { ...m, orderKey: key } : m));
            }
            members.sort((a, b) => compareStrings(a.userId ?? "", b.userId ?? ""));
            const surface = {
                ...current,
                members,
                updatedAt: Date.now(),
                version: createUuidV7Factory(Date.now, current.version)(),
            };
            await this.#kv.write(tx, `surface.${id}`, surface);
            await this.#event(tx, {
                type: "surface.updated",
                payload: {
                    surfaceId: id,
                    previousVersion: current.version,
                    version: surface.version,
                    changes: { members, updatedAt: surface.updatedAt },
                    ...echo(mutationId),
                },
            });
            return this.#present(tx, surface);
        });
    }
    async listTodos(
        ctx: Context,
        surfaceId: string,
        scope: TodoListScope = "active",
    ): Promise<Todo[]> {
        checked(todoListScopeSchema, scope);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "todo");
            const todos = (await this.#kv.list(tx, `todo.${surfaceId}.`))
                .map((row) => readTodo(row.value))
                .filter((t) => scope === "all" || t.status === scope);
            return todos.sort((a, b) => {
                const rank = { active: 0, completed: 1, deleted: 2 };
                if (a.status !== b.status) return rank[a.status] - rank[b.status];
                if (a.status === "active" && b.status === "active") return byOrder(a, b);
                return (
                    (b.deletedAt ?? b.completedAt ?? 0) - (a.deletedAt ?? a.completedAt ?? 0) ||
                    compareStrings(a.id, b.id)
                );
            });
        });
    }
    async getTodo(ctx: Context, surfaceId: string, id: string): Promise<Todo> {
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "todo");
            checked(cuid2Schema, id);
            const todo = await this.#kv.read(tx, `todo.${surfaceId}.${id}`);
            if (todo === undefined)
                throw new SurfaceError("not_found", "The todo was not found in this Surface.");
            return readTodo(todo);
        });
    }
    async createTodo(
        ctx: Context,
        surfaceId: string,
        input: CreateTodoRequest,
        actor: SurfaceActor,
        authorUserId: string | null,
    ): Promise<Todo> {
        checked(createTodoRequestSchema, input);
        if (input.id !== undefined) checked(cuid2Schema, input.id);
        return ctx.inTx(async (tx) => {
            await this.#validateUser(tx, authorUserId);
            await this.#surface(tx, surfaceId, "todo");
            const id = input.id ?? createId();
            const old = await this.#kv.read(tx, `todo.${surfaceId}.${id}`);
            if (old !== undefined) return readTodo(old);
            const now = Date.now();
            const todo: Todo = {
                id,
                surfaceId,
                text: input.text,
                authorUserId,
                status: "active",
                orderKey: surfaceOrderKey(
                    null,
                    (await this.listTodos(tx, surfaceId))[0]?.orderKey ?? null,
                ),
                createdAt: now,
                updatedAt: now,
                completedAt: null,
                deletedAt: null,
                version: createUuidV7Factory()(),
            };
            await this.#saveTodo(tx, todo, actor);
            await this.#event(tx, {
                type: "todo.created",
                payload: { todo, ...echo(input.mutationId) },
            });
            return todo;
        });
    }
    async mutateTodo(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
        operation: "update" | "reorder" | "delete",
        input: UpdateTodoRequest | { afterId: string | null } | {},
        actor: SurfaceActor,
        mutationId?: string,
    ): Promise<Todo> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            const current = await this.getTodo(tx, surfaceId, id);
            if (current.version !== version)
                throw new SurfaceError("conflict", "The todo has changed.", current);
            let candidate = { ...current } as Todo;
            if (operation === "update") {
                const edit = checked(updateTodoRequestSchema, input);
                if (edit.text !== undefined) candidate.text = edit.text;
                if (edit.status !== undefined && edit.status !== current.status) {
                    if (edit.status === "active")
                        candidate = {
                            ...candidate,
                            status: "active",
                            completedAt: null,
                            deletedAt: null,
                            orderKey: await this.#todoTail(tx, surfaceId),
                        };
                    else if (edit.status === "completed")
                        candidate = {
                            ...candidate,
                            status: "completed",
                            completedAt: Date.now(),
                            deletedAt: null,
                            orderKey: null,
                        };
                    else
                        candidate = {
                            ...candidate,
                            status: "deleted",
                            deletedAt: Date.now(),
                            orderKey: null,
                        };
                }
            } else if (operation === "delete" && current.status !== "deleted")
                candidate = {
                    ...current,
                    status: "deleted",
                    deletedAt: Date.now(),
                    orderKey: null,
                };
            else if (operation === "reorder") {
                if (current.status !== "active")
                    throw new SurfaceError(
                        "conflict",
                        "Only active todos can be reordered.",
                        current,
                    );
                const { afterId } = checked(
                    Type.Object({ afterId: Type.Union([cuid2Schema, Type.Null()]) }),
                    input,
                );
                try {
                    const key = reorderedKey(
                        (await this.listTodos(tx, surfaceId, "active")) as (Todo & {
                            orderKey: string;
                        })[],
                        id,
                        afterId,
                    );
                    if (key !== undefined) candidate = { ...current, orderKey: key };
                } catch (error) {
                    if (error instanceof SurfaceError)
                        throw new SurfaceError(error.code, error.message, current);
                    throw error;
                }
            }
            if (JSON.stringify(candidate) === JSON.stringify(current)) return current;
            const todo = checked(todoSchema, {
                ...candidate,
                updatedAt: Date.now(),
                version: createUuidV7Factory(Date.now, current.version)(),
            });
            await this.#saveTodo(tx, todo, actor);
            await this.#event(tx, {
                type: "todo.updated",
                payload: {
                    surfaceId,
                    todoId: id,
                    previousVersion: current.version,
                    version: todo.version,
                    changes: {
                        text: todo.text,
                        status: todo.status,
                        orderKey: todo.orderKey,
                        completedAt: todo.completedAt,
                        deletedAt: todo.deletedAt,
                        updatedAt: todo.updatedAt,
                    },
                    ...echo(mutationId),
                },
            });
            return todo;
        });
    }
    async versions(
        ctx: Context,
        surfaceId: string,
        id: string,
        afterVersion?: string,
        limit = 100,
    ) {
        checked(Type.Integer({ minimum: 1, maximum: 200 }), limit);
        return ctx.inTx(async (tx) => {
            await this.getTodo(tx, surfaceId, id);
            if (afterVersion !== undefined) await this.getVersion(tx, surfaceId, id, afterVersion);
            const rows = (
                await this.#store.queryPage(
                    tx,
                    `revision.${surfaceId}.${id}.`,
                    afterVersion ?? "",
                    limit + 1,
                )
            ).map(readRevision);
            const versions = rows.slice(0, limit);
            return {
                versions,
                nextAfterVersion: rows.length > limit ? versions.at(-1)!.todo.version : null,
            };
        });
    }
    async getVersion(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
    ): Promise<TodoRevision> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            await this.getTodo(tx, surfaceId, id);
            const row = await this.#kv.read(tx, `revision.${surfaceId}.${id}.${version}`);
            if (row === undefined)
                throw new SurfaceError("not_found", "The todo revision was not found.");
            return readRevision(row);
        });
    }
    async getDocument(ctx: Context, surfaceId: string): Promise<SurfaceDocument> {
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "document");
            return checked(surfaceDocumentSchema, await this.#kv.read(tx, `document.${surfaceId}`));
        });
    }
    async updateDocument(
        ctx: Context,
        surfaceId: string,
        version: string,
        input: UpdateSurfaceDocumentRequest,
        actor: SurfaceActor,
    ): Promise<SurfaceDocument> {
        checked(resourceVersionSchema, version);
        checked(updateSurfaceDocumentRequestSchema, input);
        return ctx.inTx(async (tx) => {
            const current = await this.getDocument(tx, surfaceId);
            if (current.version !== version) throw new SurfaceDocumentConflictError(current);
            if (current.text === input.text) return current;
            const document: SurfaceDocument = {
                ...current,
                text: input.text,
                lastEditorUserId: actor.userId,
                updatedAt: Date.now(),
                version: createUuidV7Factory(Date.now, current.version)(),
            };
            await this.#saveDocument(tx, document, actor, input.mutationId);
            await this.#event(tx, {
                type: "surface.document.updated",
                payload: {
                    surfaceId,
                    previousVersion: current.version,
                    version: document.version,
                    changes: {
                        text: document.text,
                        lastEditorUserId: document.lastEditorUserId,
                        updatedAt: document.updatedAt,
                    },
                    ...echo(input.mutationId),
                },
            });
            return document;
        });
    }
    async documentVersions(
        ctx: Context,
        surfaceId: string,
        afterVersion?: string,
        limit = 100,
    ): Promise<SurfaceDocumentVersionListResponse> {
        checked(Type.Integer({ minimum: 1, maximum: 200 }), limit);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "document");
            if (afterVersion !== undefined) {
                checked(documentHistoryCursorSchema, afterVersion);
                if (
                    (await this.#kv.read(tx, `document-summary.${surfaceId}.${afterVersion}`)) ===
                    undefined
                )
                    throw new SurfaceError("not_found", "The document revision was not found.");
            }
            const rows = (
                await this.#store.queryPage(
                    tx,
                    `document-summary.${surfaceId}.`,
                    afterVersion ?? "",
                    limit + 1,
                )
            ).map((row) => checked(surfaceDocumentVersionSummarySchema, row));
            const versions = rows.slice(0, limit);
            return {
                versions,
                nextAfterVersion: rows.length > limit ? versions.at(-1)!.version : null,
            };
        });
    }
    async getDocumentVersion(
        ctx: Context,
        surfaceId: string,
        version: string,
    ): Promise<SurfaceDocumentRevision> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "document");
            const revision = await this.#kv.read(tx, `document-revision.${surfaceId}.${version}`);
            if (revision === undefined)
                throw new SurfaceError("not_found", "The document revision was not found.");
            return checked(surfaceDocumentRevisionSchema, revision);
        });
    }
    async #saveDocument(
        ctx: Context,
        document: SurfaceDocument,
        actor: SurfaceActor,
        mutationId?: string,
    ): Promise<void> {
        const revision = checked(surfaceDocumentRevisionSchema, {
            document,
            actor,
            mutationId: mutationId ?? null,
            source: actor.agentId === null ? "api" : "tool",
        });
        const { document: _snapshot, ...metadata } = revision;
        const summary = { ...metadata, version: document.version, updatedAt: document.updatedAt };
        if (
            !(await this.#store.writeValueIfAbsent(
                ctx,
                `document-revision.${document.surfaceId}.${document.version}`,
                revision,
            )) ||
            !(await this.#store.writeValueIfAbsent(
                ctx,
                `document-summary.${document.surfaceId}.${document.version}`,
                summary,
            ))
        )
            throw new Error("A document revision cannot be overwritten.");
        await this.#kv.write(ctx, `document.${document.surfaceId}`, document);
    }
    async #stored(ctx: Context): Promise<Surface[]> {
        return (await this.#kv.list(ctx, "surface.")).map((row) => readSurface(row.value));
    }
    /** Shared records never hold a target projection; it is resolved for each read. */
    async #present(ctx: Context, surface: Surface): Promise<Surface> {
        if (!isReferenceType(surface.type)) return surface;
        const stored = await this.#kv.read(ctx, `reference.${surface.id}`);
        return {
            ...surface,
            target: Value.Check(surfaceReferenceSchema, stored)
                ? await this.#resolve(ctx, stored)
                : { type: surface.type, state: "unavailable" },
        };
    }
    /**
     * Every authenticated person may read every bot, task, and artifact, so availability is the
     * target's own lifecycle. Unavailable projections never carry the target's identity.
     */
    async #resolve(ctx: Context, reference: SurfaceReference): Promise<SurfaceTarget> {
        if (reference.type === "artifact") {
            const artifact = await this.artifacts.get(ctx, reference.artifactId);
            if (artifact === undefined || artifact.status !== "active")
                return { type: "artifact", state: "unavailable" };
            return {
                type: "artifact",
                state: "available",
                artifactId: artifact.id,
                name: artifact.title,
                hasImage: artifact.type === "image" || artifact.type === "image_series",
                version: apiResourceVersion(artifact.updatedAt, artifact.revision, artifact.id),
            };
        }
        if (reference.type === "bot") {
            const bot = await this.bots.get(ctx, reference.botId);
            if (bot === undefined || bot.status !== "active")
                return { type: "bot", state: "unavailable" };
            return {
                type: "bot",
                state: "available",
                botId: bot.id,
                name: bot.name,
                hasImage: bot.avatar !== undefined,
                version: apiResourceVersion(bot.updatedAt, bot.version, bot.id),
            };
        }
        const task = await this.tasks.get(ctx, reference.taskId);
        if (task === undefined || task.status !== "active")
            return { type: "task", state: "unavailable" };
        return {
            type: "task",
            state: "available",
            taskId: task.id,
            name: task.name,
            hasImage: false,
            version: apiResourceVersion(task.updatedAt, task.version, task.id),
        };
    }
    async #surface(ctx: Context, id: string, type?: Surface["type"]): Promise<Surface> {
        checked(surfaceIdSchema, id);
        const value = await this.#kv.read(ctx, `surface.${id}`);
        if (value === undefined) throw new SurfaceError("not_found", "The Surface was not found.");
        const surface = readSurface(value);
        if (type !== undefined && surface.type !== type)
            throw new SurfaceError("not_found", "The Surface was not found.");
        return surface;
    }
    async #validateUser(ctx: Context, userId: string | null): Promise<void> {
        checked(surfaceMemberSchema.properties.userId, userId);
        if (userId === null) return;
        if (!this.team.enabled)
            throw new SurfaceError("invalid_request", "Standalone Surfaces use the local person.");
        const target = await this.team.getUser(ctx, userId);
        if (target === undefined || target.authentication === "guest")
            throw new SurfaceError("not_found", "The Surface user was not found.");
    }
    async #memberTail(ctx: Context, userId: string | null): Promise<string> {
        const keys = (await this.#stored(ctx))
            .flatMap((s) => s.members.filter((m) => m.userId === userId).map((m) => m.orderKey))
            .sort(compareStrings);
        return surfaceOrderKey(keys.at(-1) ?? null, null);
    }
    async #todoTail(ctx: Context, surfaceId: string): Promise<string> {
        return surfaceOrderKey(
            (await this.listTodos(ctx, surfaceId)).at(-1)?.orderKey ?? null,
            null,
        );
    }
    async #saveTodo(ctx: Context, todo: Todo, actor: SurfaceActor): Promise<void> {
        const revision = checked(todoRevisionSchema, {
            todo,
            actor,
            source: actor.agentId === null ? "api" : "tool",
        });
        if (
            !(await this.#store.writeValueIfAbsent(
                ctx,
                `revision.${todo.surfaceId}.${todo.id}.${todo.version}`,
                revision,
            ))
        )
            throw new Error("A todo revision cannot be overwritten.");
        await this.#kv.write(ctx, `todo.${todo.surfaceId}.${todo.id}`, todo);
    }
    async #event(ctx: Context, event: SurfaceEvent): Promise<void> {
        for (const listener of this.#transactional) await listener(ctx, structuredClone(event));
        await this.durable.invoke(ctx, {
            function: "surfaces.notify",
            arguments: event,
            lockKeys: ["surfaces.notify"],
        });
    }
}

/** Older snapshots have no attribution; reads never infer it or rewrite stored history. */
function readSurface(value: unknown): Surface {
    const surface = checked(surfaceSchema, value);
    return { ...surface, creatorUserId: surface.creatorUserId ?? null };
}
function readTodo(value: unknown): Todo {
    const todo = checked(todoSchema, value);
    return { ...todo, authorUserId: todo.authorUserId ?? null };
}
function readRevision(value: unknown): TodoRevision {
    const revision = checked(todoRevisionSchema, value);
    return {
        ...revision,
        todo: { ...revision.todo, authorUserId: revision.todo.authorUserId ?? null },
    };
}
function isReferenceType(type: string): type is SurfaceReference["type"] {
    return type === "artifact" || type === "bot" || type === "task";
}
function referenceFor(input: Static<typeof supportedCreationSchema>): SurfaceReference | undefined {
    if (input.type === "artifact") return { type: "artifact", artifactId: input.artifactId };
    if (input.type === "bot") return { type: "bot", botId: input.botId };
    if (input.type === "task") return { type: "task", taskId: input.taskId };
    return undefined;
}
function echo(mutationId?: string) {
    return mutationId === undefined ? {} : { mutationId };
}
function checked<S extends TSchema>(schema: S, value: unknown): Static<S> {
    if (!Value.Check(schema, value))
        throw new SurfaceError(
            "invalid_request",
            "The Surface request or stored value is invalid.",
        );
    return value as Static<S>;
}
function byOrder(a: { orderKey: string; id: string }, b: { orderKey: string; id: string }) {
    return compareStrings(a.orderKey, b.orderKey) || compareStrings(a.id, b.id);
}
function reorderedKey(
    items: { id: string; orderKey: string }[],
    id: string,
    afterId: string | null,
): string | undefined {
    if (afterId === id || (afterId !== null && !items.some((i) => i.id === afterId)))
        throw new SurfaceError(
            "conflict",
            "The ordering anchor must be a different active item in this list.",
        );
    const index = items.findIndex((i) => i.id === id);
    if ((items[index - 1]?.id ?? null) === afterId) return undefined;
    const others = items.filter((i) => i.id !== id);
    const anchor = afterId === null ? -1 : others.findIndex((i) => i.id === afterId);
    return surfaceOrderKey(others[anchor]?.orderKey ?? null, others[anchor + 1]?.orderKey ?? null);
}
