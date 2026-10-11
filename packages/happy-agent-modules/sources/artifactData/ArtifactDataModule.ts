import { dirname } from "node:path";

import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { ArtifactsModule } from "../artifacts/index.js";
import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { ProfileModule } from "../profile/index.js";
import { TeamModule, teamUser, type TeamUser } from "../team/index.js";

import {
    ArtifactDataInputError,
    ArtifactDataNotFoundError,
    artifactDataUserIdSchema,
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
    type ArtifactDataUser,
    type ArtifactDataWrite,
    type ArtifactLogBatch,
    type ArtifactLogPage,
    type ArtifactLogQuery,
} from "./ArtifactData.js";
import {
    ArtifactDataStores,
    artifactDataAuthorId,
    opaqueArtifactDataId,
} from "./impl/ArtifactDataStores.js";
import {
    ARTIFACT_DATA_CLIENT_ETAG,
    ARTIFACT_DATA_CLIENT_SCRIPT,
} from "./impl/artifactDataClientScript.js";
import { readArtifactDataTool } from "./tools/read_artifact_data.js";
import { readArtifactLogsTool } from "./tools/read_artifact_logs.js";
import { writeArtifactDataTool } from "./tools/write_artifact_data.js";

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

    readonly #artifacts: ArtifactsModule;
    readonly #profile: ProfileModule;
    readonly #team: TeamModule;
    readonly #bots: BotsModule;
    readonly #stores: ArtifactDataStores;

    constructor(
        config: ConfigModule,
        artifacts: ArtifactsModule,
        profile: ProfileModule,
        team: TeamModule,
        bots: BotsModule,
    ) {
        this.#artifacts = artifacts;
        this.#profile = profile;
        this.#team = team;
        this.#bots = bots;
        this.#stores = new ArtifactDataStores((artifactId) =>
            dirname(config.artifactDataPath(artifactId)),
        );
        artifacts.onEvent((_ctx, event) => {
            if (event.type === "artifact_deleted") {
                this.#stores.end(event.artifact.id, "artifact_deleted");
            }
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (_ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => [
            readArtifactDataTool(this),
            writeArtifactDataTool(this, scope.agent.id),
            readArtifactLogsTool(this),
        ],
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /** The browser SDK an artifact page loads from `/api/v1/client.js`, and its ETag. */
    clientScript(): { readonly text: string; readonly etag: string } {
        return { text: ARTIFACT_DATA_CLIENT_SCRIPT, etag: ARTIFACT_DATA_CLIENT_ETAG };
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
        await this.#requireActive(ctx, artifactId);
        const agents = await this.#stores.agents(ctx, artifactId, rest);
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
        return artifactDataAuthorId(author);
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
        await this.#requireActive(ctx, artifactId);
        return await this.#stores.get(ctx, artifactId, key);
    }

    async list(
        ctx: Context,
        artifactId: string,
        query: ArtifactDataListQuery = {},
    ): Promise<ArtifactDataPage> {
        await this.#requireActive(ctx, artifactId);
        return await this.#stores.list(ctx, artifactId, query);
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
        await this.#requireActive(ctx, artifactId);
        return await this.#stores.changes(ctx, artifactId, query);
    }

    async set(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataSetInput,
    ): Promise<ArtifactDataWrite> {
        await this.#requireActive(ctx, artifactId);
        return await this.#stores.set(ctx, artifactId, input);
    }

    async delete(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataDeleteInput,
    ): Promise<ArtifactDataWrite> {
        await this.#requireActive(ctx, artifactId);
        return await this.#stores.delete(ctx, artifactId, input);
    }

    /**
     * Keep what the caller's page reported in the artifact's debug log, as the caller, with the
     * artifact's newest version. Entries past the caller's rate for this minute are dropped.
     */
    async appendLogs(
        ctx: Context,
        artifactId: string,
        batch: ArtifactLogBatch,
    ): Promise<{ readonly accepted: number; readonly dropped: number }> {
        const artifact = await this.#artifacts.get(ctx, artifactId);
        if (artifact === undefined || artifact.status !== "active") {
            throw new ArtifactDataNotFoundError();
        }
        return await this.#stores.appendLogs(ctx, artifactId, {
            userId: await this.userId(ctx),
            version: artifact.latestVersion,
            batch,
        });
    }

    /** The artifact's kept debug log, newest first. */
    async readLogs(
        ctx: Context,
        artifactId: string,
        query: ArtifactLogQuery = {},
    ): Promise<ArtifactLogPage> {
        await this.#requireActive(ctx, artifactId);
        return await this.#stores.readLogs(ctx, artifactId, query);
    }

    /**
     * Hear every change to one artifact's store after it commits, in version order, until the
     * artifact is deleted or the module closes. Subscribing first and reading `changes` after
     * misses nothing; a change seen twice has the same version.
     */
    subscribe(artifactId: string, listener: ArtifactDataListener): () => void {
        return this.#stores.subscribe(artifactId, listener);
    }

    /** Subscribers of every store, for bounding open change streams. */
    subscriberCount(artifactId?: string): number {
        return this.#stores.subscriberCount(artifactId);
    }

    async close(ctx: Context): Promise<void> {
        await this.#stores.close(ctx);
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
    return opaqueArtifactDataId("u", `happy-artifact-user:${profileId}`);
}
