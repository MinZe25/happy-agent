import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname } from "node:path";

import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import { Value } from "@sinclair/typebox/value";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import { ArtifactsModule } from "../artifacts/index.js";
import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { ProfileModule } from "../profile/index.js";
import { TeamModule, teamUser, type TeamUser } from "../team/index.js";

import {
    ARTIFACT_DATA_LIMITS,
    ArtifactDataCursorUnavailableError,
    ArtifactDataInputError,
    ArtifactDataNotFoundError,
    ArtifactDataTooLargeError,
    artifactDataChangesQuerySchema,
    artifactDataDeleteInputSchema,
    artifactDataKeySchema,
    artifactDataListQuerySchema,
    artifactDataSetInputSchema,
    artifactDataUserIdSchema,
    DEFAULT_ARTIFACT_DATA_PAGE_SIZE,
    type ArtifactDataAuthor,
    type ArtifactDataChanges,
    type ArtifactDataChangesQuery,
    type ArtifactDataDeleteInput,
    type ArtifactDataEntry,
    type ArtifactDataListener,
    type ArtifactDataListQuery,
    type ArtifactDataPage,
    type ArtifactDataPhoto,
    type ArtifactDataSetInput,
    type ArtifactDataSignal,
    type ArtifactDataUser,
    type ArtifactDataWrite,
} from "./ArtifactData.js";
import { ArtifactDataStore, type ArtifactDataOperation } from "./impl/ArtifactDataStore.js";
import { ARTIFACT_DATA_CLIENT_SCRIPT } from "./impl/artifactDataClientScript.js";
import { readArtifactDataTool } from "./tools/read_artifact_data.js";
import { writeArtifactDataTool } from "./tools/write_artifact_data.js";

/** Stores kept open at once; the least recently used one closes when another opens. */
const MAX_OPEN_STORES = 32;

/**
 * Realtime key-value data for artifact pages, so an HTML artifact can be a small shared app.
 *
 * Each artifact has one store, shared by all of its versions and by every person and device
 * using the daemon, in a SQLite file of its own under the artifacts folder's `_data_` directory.
 * Every write gets a new UUIDv7 from the store's own high-water mark, so a version orders
 * changes, resumes a change feed, and tells when the write happened. Writes to one store are
 * serialized and their changes reach subscribers in version order after they commit.
 *
 * A store lives in its own file, so its operations commit on their own and never take part in a
 * caller's main-database transaction. Agents read and write stores through their own tools, as
 * an author whose stable ID a page can resolve to a name but never to the agent's own ID.
 */
export class ArtifactDataModule implements AgentModule {
    readonly name = "artifactData";

    readonly #config: ConfigModule;
    readonly #artifacts: ArtifactsModule;
    readonly #profile: ProfileModule;
    readonly #team: TeamModule;
    readonly #bots: BotsModule;
    readonly #locks: MapAsyncLock<string> = mapAsyncLock();
    /** Open stores, least recently used first. */
    readonly #stores = new Map<string, ArtifactDataStore>();
    readonly #listeners = new Map<string, Set<ArtifactDataListener>>();
    readonly #clientEtag = `"${createHash("sha256").update(ARTIFACT_DATA_CLIENT_SCRIPT).digest("hex").slice(0, 32)}"`;
    #closed = false;

    constructor(
        config: ConfigModule,
        artifacts: ArtifactsModule,
        profile: ProfileModule,
        team: TeamModule,
        bots: BotsModule,
    ) {
        this.#config = config;
        this.#artifacts = artifacts;
        this.#profile = profile;
        this.#team = team;
        this.#bots = bots;
        artifacts.onEvent((_ctx, event) => {
            if (event.type === "artifact_deleted") {
                this.#end(event.artifact.id, { type: "closed", reason: "artifact_deleted" });
            }
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (_ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => [
            readArtifactDataTool(this),
            writeArtifactDataTool(this, scope.agent.id),
        ],
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /** The browser SDK an artifact page loads from `/api/v1/client.js`, and its ETag. */
    clientScript(): { readonly text: string; readonly etag: string } {
        return { text: ARTIFACT_DATA_CLIENT_SCRIPT, etag: this.#clientEtag };
    }

    /**
     * The ID a page knows the caller by: a team member's Happy user ID, or in standalone mode a
     * stable ID derived from the installation's profile, which never reveals that identity.
     */
    async userId(ctx: Context): Promise<string> {
        if (this.#team.enabled) {
            const user = teamUser(ctx);
            if (user === undefined)
                throw new ArtifactDataNotFoundError("The caller is not a team member.");
            return user.id;
        }
        return standaloneUserId((await this.#profile.ensure(ctx)).id);
    }

    /** The caller as a page sees them. */
    async me(ctx: Context): Promise<ArtifactDataUser> {
        if (this.#team.enabled) {
            const user = teamUser(ctx);
            if (user === undefined)
                throw new ArtifactDataNotFoundError("The caller is not a team member.");
            return teamUserResource(user);
        }
        return await this.#standaloneUser(ctx);
    }

    /**
     * People, and agents that wrote to this artifact's store, by ID: in the order asked, each
     * once. Unknown IDs are left out.
     */
    async users(
        ctx: Context,
        artifactId: string,
        ids: readonly string[],
    ): Promise<readonly ArtifactDataUser[]> {
        if (ids.length > 100 || !ids.every((id) => Value.Check(artifactDataUserIdSchema, id))) {
            throw new ArtifactDataInputError("Provide at most 100 valid user IDs.");
        }
        const unique = [...new Set(ids)];
        const found = new Map<string, ArtifactDataUser>();
        if (this.#team.enabled) {
            for (const user of await this.#team.getUsers(ctx, unique)) {
                found.set(user.id, teamUserResource(user));
            }
        } else {
            const self = await this.#standaloneUser(ctx);
            if (unique.includes(self.id)) found.set(self.id, self);
        }
        const rest = unique.filter((id) => !found.has(id));
        const agents = await this.#read(
            ctx,
            artifactId,
            () => new Map<string, string>(),
            (store) => store.agents(rest),
        );
        for (const [id, agentId] of agents) {
            const name = (await this.#bots.forAgent(ctx, agentId))?.name ?? "Agent";
            found.set(id, {
                id,
                kind: "agent",
                name,
                firstName: name,
                lastName: null,
                photoUrl: null,
            });
        }
        return unique.flatMap((id) => {
            const user = found.get(id);
            return user === undefined ? [] : [user];
        });
    }

    /** The ID a page knows an author by. */
    authorId(author: ArtifactDataAuthor): string {
        return author.kind === "user" ? author.userId : agentAuthorId(author.agentId);
    }

    async userPhoto(ctx: Context, userId: string): Promise<ArtifactDataPhoto | undefined> {
        if (!Value.Check(artifactDataUserIdSchema, userId)) {
            throw new ArtifactDataInputError("Provide a valid user ID.");
        }
        if (this.#team.enabled) return await this.#team.getUserPhoto(ctx, userId);
        if (userId !== standaloneUserId((await this.#profile.ensure(ctx)).id)) return undefined;
        return await this.#profile.getPhoto(ctx);
    }

    async get(
        ctx: Context,
        artifactId: string,
        key: string,
    ): Promise<{ readonly entry: ArtifactDataEntry | undefined; readonly cursor: string | null }> {
        if (!Value.Check(artifactDataKeySchema, key))
            throw new ArtifactDataInputError("The key is invalid.");
        return await this.#read(
            ctx,
            artifactId,
            () => ({ entry: undefined, cursor: null }),
            (store) => store.get(key),
        );
    }

    async list(
        ctx: Context,
        artifactId: string,
        query: ArtifactDataListQuery = {},
    ): Promise<ArtifactDataPage> {
        if (!Value.Check(artifactDataListQuerySchema, query)) {
            throw new ArtifactDataInputError("The list query is invalid.");
        }
        return await this.#read(
            ctx,
            artifactId,
            () => ({ entries: [], nextAfter: undefined, cursor: null }),
            (store) =>
                store.list(
                    query.prefix ?? "",
                    query.after,
                    query.limit ?? DEFAULT_ARTIFACT_DATA_PAGE_SIZE,
                ),
        );
    }

    /**
     * Changes after `since` in version order, tombstones included, each key once as it is now.
     * Without `since` the feed starts at the beginning, so it describes the whole store.
     */
    async changes(
        ctx: Context,
        artifactId: string,
        query: ArtifactDataChangesQuery = {},
    ): Promise<ArtifactDataChanges> {
        if (!Value.Check(artifactDataChangesQuerySchema, query)) {
            throw new ArtifactDataInputError("The changes query is invalid.");
        }
        return await this.#read(
            ctx,
            artifactId,
            () => {
                // No write was ever made, so no cursor can have come from this store.
                if (query.since !== undefined) throw new ArtifactDataCursorUnavailableError();
                return { changes: [], cursor: null, hasMore: false };
            },
            (store) =>
                store.changes(
                    query.since,
                    query.prefix ?? "",
                    query.limit ?? DEFAULT_ARTIFACT_DATA_PAGE_SIZE,
                ),
        );
    }

    async set(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataSetInput,
    ): Promise<ArtifactDataWrite> {
        if (!Value.Check(artifactDataSetInputSchema, input)) {
            throw new ArtifactDataInputError("The write is invalid.");
        }
        let valueJson: string | undefined;
        try {
            valueJson = JSON.stringify(input.value);
        } catch {
            valueJson = undefined;
        }
        if (valueJson === undefined) throw new ArtifactDataInputError("The value must be JSON.");
        if (Buffer.byteLength(valueJson) > ARTIFACT_DATA_LIMITS.valueBytes) {
            throw new ArtifactDataTooLargeError("too_large", "The value is larger than 256 KiB.");
        }
        return await this.#write(
            ctx,
            artifactId,
            { kind: "set", key: input.key, valueJson },
            input,
        );
    }

    async delete(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataDeleteInput,
    ): Promise<ArtifactDataWrite> {
        if (!Value.Check(artifactDataDeleteInputSchema, input)) {
            throw new ArtifactDataInputError("The deletion is invalid.");
        }
        return await this.#write(ctx, artifactId, { kind: "delete", key: input.key }, input);
    }

    /**
     * Hear every change to one artifact's store after it commits, in version order, until the
     * artifact is deleted or the module closes. Subscribing first and reading `changes` after
     * misses nothing; a change seen twice has the same version.
     */
    subscribe(artifactId: string, listener: ArtifactDataListener): () => void {
        if (this.#closed) {
            listener({ type: "closed", reason: "shutdown" });
            return () => undefined;
        }
        let listeners = this.#listeners.get(artifactId);
        if (listeners === undefined) {
            listeners = new Set();
            this.#listeners.set(artifactId, listeners);
        }
        listeners.add(listener);
        return () => {
            const current = this.#listeners.get(artifactId);
            current?.delete(listener);
            if (current?.size === 0) this.#listeners.delete(artifactId);
        };
    }

    /** Subscribers of every store, for bounding open change streams. */
    subscriberCount(artifactId?: string): number {
        if (artifactId !== undefined) return this.#listeners.get(artifactId)?.size ?? 0;
        let count = 0;
        for (const listeners of this.#listeners.values()) count += listeners.size;
        return count;
    }

    async close(ctx: Context): Promise<void> {
        this.#closed = true;
        for (const artifactId of [...this.#listeners.keys()]) {
            this.#end(artifactId, { type: "closed", reason: "shutdown" });
        }
        await Promise.all(
            [...this.#stores.keys()].map(async (artifactId) => {
                await this.#locks.runInLock(ctx, artifactId, async () => {
                    this.#stores.get(artifactId)?.close();
                    this.#stores.delete(artifactId);
                });
            }),
        );
    }

    async #standaloneUser(ctx: Context): Promise<ArtifactDataUser> {
        const profile = await this.#profile.ensure(ctx);
        const id = standaloneUserId(profile.id);
        const [firstName = null, ...rest] = profile.name?.trim().split(/\s+/) ?? [];
        return {
            id,
            kind: "user",
            name: profile.name,
            firstName,
            lastName: rest.length === 0 ? null : rest.join(" "),
            photoUrl: profile.photo === null ? null : photoUrl(id, profile.photo.contentHash),
        };
    }

    /** Whether the artifact exists and is not deleted, so its data is served. */
    async serves(ctx: Context, artifactId: string): Promise<boolean> {
        const artifact = await this.#artifacts.get(ctx, artifactId);
        return artifact !== undefined && artifact.status === "active";
    }

    async #requireActive(ctx: Context, artifactId: string): Promise<void> {
        const artifact = await this.#artifacts.get(ctx, artifactId);
        if (artifact === undefined || artifact.status !== "active") {
            throw new ArtifactDataNotFoundError();
        }
    }

    /** Read a store; a store never written answers `absent()` without creating its file. */
    async #read<Result>(
        ctx: Context,
        artifactId: string,
        absent: () => Result,
        read: (store: ArtifactDataStore) => Promise<Result>,
    ): Promise<Result> {
        await this.#requireActive(ctx, artifactId);
        return await this.#locks.runInLock(ctx, artifactId, async (lockCtx) => {
            const store = await this.#store(lockCtx, artifactId, false);
            return store === undefined ? absent() : await read(store);
        });
    }

    async #write(
        ctx: Context,
        artifactId: string,
        operation: ArtifactDataOperation,
        input: ArtifactDataSetInput | ArtifactDataDeleteInput,
    ): Promise<ArtifactDataWrite> {
        await this.#requireActive(ctx, artifactId);
        return await this.#locks.runInLock(ctx, artifactId, async (lockCtx) => {
            const store = await this.#store(lockCtx, artifactId, true);
            if (store === undefined) throw new Error("The artifact data store did not open.");
            const result = await store.write(
                operation,
                this.authorId(input.author),
                input.writeId,
                input.condition,
                Date.now(),
                input.author.kind === "agent" ? input.author.agentId : undefined,
            );
            // Still inside the store's lock, so subscribers hear changes in version order.
            if (result.changed) this.#emit(artifactId, { type: "change", entry: result.entry });
            return { entry: result.entry, replayed: result.replayed };
        });
    }

    /** The open store, opening it when needed; `undefined` when absent and not to be created. */
    async #store(
        ctx: Context,
        artifactId: string,
        create: boolean,
    ): Promise<ArtifactDataStore | undefined> {
        if (this.#closed) throw new Error("Artifact data is shutting down.");
        const open = this.#stores.get(artifactId);
        if (open !== undefined) {
            this.#stores.delete(artifactId);
            this.#stores.set(artifactId, open);
            return open;
        }
        const path = this.#config.artifactDataPath(artifactId);
        if (!create && !(await exists(path))) return undefined;
        await ensurePrivateDirectory(dirname(path));
        const store = await ArtifactDataStore.open(path);
        this.#stores.set(artifactId, store);
        const [oldest] = this.#stores.keys();
        if (this.#stores.size > MAX_OPEN_STORES && oldest !== undefined && oldest !== artifactId) {
            void this.#locks
                .runInLock(ctx, oldest, async () => {
                    const evicted = this.#stores.get(oldest);
                    if (evicted === undefined || this.#stores.size <= MAX_OPEN_STORES) return;
                    this.#stores.delete(oldest);
                    evicted.close();
                })
                .catch(() => undefined);
        }
        return store;
    }

    #emit(artifactId: string, signal: ArtifactDataSignal): void {
        for (const listener of [...(this.#listeners.get(artifactId) ?? [])]) {
            try {
                listener(signal);
            } catch {
                // One subscriber's failure is its own; the change is already committed.
            }
        }
    }

    #end(artifactId: string, signal: ArtifactDataSignal): void {
        this.#emit(artifactId, signal);
        this.#listeners.delete(artifactId);
    }
}

function teamUserResource(user: TeamUser): ArtifactDataUser {
    return {
        id: user.id,
        kind: "user",
        name: user.lastName === null ? user.firstName : `${user.firstName} ${user.lastName}`,
        firstName: user.firstName,
        lastName: user.lastName,
        photoUrl: user.photo === null ? null : photoUrl(user.id, user.photo.contentHash),
    };
}

/** A page-relative photo URL that changes whenever the photo does. */
function photoUrl(userId: string, contentHash: string): string {
    return `/api/v1/users/${userId}/photo?v=${contentHash.slice(0, 16)}`;
}

/** A stable ID for the standalone person that cannot be turned back into the profile's own. */
function standaloneUserId(profileId: string): string {
    return opaqueId("u", `happy-artifact-user:${profileId}`);
}

/** A stable ID for an agent that cannot be turned back into the agent's own. */
function agentAuthorId(agentId: string): string {
    return opaqueId("a", `happy-artifact-agent:${agentId}`);
}

function opaqueId(first: string, seed: string): string {
    const digest = createHash("sha256").update(seed).digest();
    let id = first;
    for (const byte of digest.subarray(0, 23)) {
        id += "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36];
    }
    return id;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
