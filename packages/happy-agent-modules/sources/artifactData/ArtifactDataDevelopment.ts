import { createHash } from "node:crypto";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import {
    ArtifactDataInputError,
    artifactDataEntrySchema,
    artifactDataUserIdSchema,
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
import { ArtifactDataStores, opaqueArtifactDataId } from "./impl/ArtifactDataStores.js";
import {
    ARTIFACT_DATA_CLIENT_ETAG,
    ARTIFACT_DATA_CLIENT_SCRIPT,
} from "./impl/artifactDataClientScript.js";

/** The name a development caller has when it names nobody. */
export const ARTIFACT_DATA_DEVELOPMENT_DEFAULT_USER = "you";

const userNameSchema = Type.String({ minLength: 1, maxLength: 40, pattern: "^[^\\x00-\\x1f]+$" });

/** One artifact's data as a file: every entry, tombstones included, and who wrote them. */
export const artifactDataDumpSchema = Type.Object(
    {
        format: Type.Literal("happy-artifact-data/1"),
        artifactId: Type.String(),
        entries: Type.Array(artifactDataEntrySchema),
        users: Type.Array(
            Type.Object(
                {
                    id: artifactDataUserIdSchema,
                    kind: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
                    name: Type.Union([Type.String(), Type.Null()]),
                },
                { additionalProperties: true },
            ),
        ),
    },
    { additionalProperties: false },
);
export type ArtifactDataDump = Static<typeof artifactDataDumpSchema>;

const developmentUserNamespace = createContextNamespace<string | undefined>(
    "happyAgent.artifactDataDevelopmentUser",
    undefined,
    { detachable: false },
);

/**
 * One artifact's data served by `happy-agent artifact dev`, outside any daemon, with the same
 * stores, limits, versions, and change feed the daemon uses. Only who the callers are differs:
 * they are made-up people, known by name, each with a generated photo, so one browser can be
 * several people at once. Nothing here reaches a daemon; data copied from one arrives as a dump.
 */
export class ArtifactDataDevelopment {
    readonly artifactId: string;
    readonly #stores: ArtifactDataStores;
    /** Known people by ID, in the order they first appeared. */
    readonly #users = new Map<string, ArtifactDataUser>();

    /** Serve `artifactId`'s data from files under `directory`. */
    constructor(directory: string, artifactId: string) {
        this.artifactId = artifactId;
        this.#stores = new ArtifactDataStores((id) => join(directory, id));
    }

    /** The person `name` stands for, made up the first time anyone uses the name. */
    user(name: string): ArtifactDataUser {
        const trimmed = name.trim();
        if (!Value.Check(userNameSchema, trimmed)) {
            throw new ArtifactDataInputError("A user name is 1–40 characters.");
        }
        const id = opaqueArtifactDataId("u", `happy-artifact-dev-user:${trimmed.toLowerCase()}`);
        const known = this.#users.get(id);
        if (known !== undefined) return known;
        const words = trimmed.split(/\s+/).map((word) => word[0]?.toUpperCase() + word.slice(1));
        const user = developmentUser(id, words.join(" "));
        this.#users.set(id, user);
        return user;
    }

    /** Everyone known, in the order they first appeared. */
    knownUsers(): readonly ArtifactDataUser[] {
        return [...this.#users.values()];
    }

    /** Derive a request context made by the person `name` stands for. */
    as(ctx: Context, name: string): Context {
        return developmentUserNamespace.set(ctx, this.user(name).id);
    }

    clientScript(): { readonly text: string; readonly etag: string } {
        return { text: ARTIFACT_DATA_CLIENT_SCRIPT, etag: ARTIFACT_DATA_CLIENT_ETAG };
    }

    async serves(_ctx: Context, artifactId: string): Promise<boolean> {
        return artifactId === this.artifactId;
    }

    async userId(ctx: Context): Promise<string> {
        return (await this.me(ctx)).id;
    }

    async me(ctx: Context): Promise<ArtifactDataUser> {
        const id = developmentUserNamespace.get(ctx);
        return (
            (id === undefined ? undefined : this.#users.get(id)) ??
            this.user(ARTIFACT_DATA_DEVELOPMENT_DEFAULT_USER)
        );
    }

    async users(
        ctx: Context,
        artifactId: string,
        ids: readonly string[],
    ): Promise<readonly ArtifactDataUser[]> {
        if (ids.length > 100 || !ids.every((id) => Value.Check(artifactDataUserIdSchema, id))) {
            throw new ArtifactDataInputError("Provide at most 100 valid user IDs.");
        }
        const unique = [...new Set(ids)];
        const agents = await this.#stores.agents(
            ctx,
            artifactId,
            unique.filter((id) => !this.#users.has(id)),
        );
        return unique.flatMap((id): ArtifactDataUser[] => {
            const user = this.#users.get(id);
            if (user !== undefined) return [user];
            if (!agents.has(id)) return [];
            return [
                {
                    id,
                    kind: "agent",
                    name: "Agent",
                    firstName: "Agent",
                    lastName: null,
                    photoUrl: null,
                },
            ];
        });
    }

    async userPhoto(_ctx: Context, userId: string): Promise<ArtifactDataPhoto | undefined> {
        if (!Value.Check(artifactDataUserIdSchema, userId)) {
            throw new ArtifactDataInputError("Provide a valid user ID.");
        }
        const user = this.#users.get(userId);
        if (user === undefined || user.kind !== "user") return undefined;
        return developmentPhoto(user);
    }

    async get(
        ctx: Context,
        artifactId: string,
        key: string,
    ): Promise<{ readonly entry: ArtifactDataEntry | undefined; readonly cursor: string | null }> {
        return await this.#stores.get(ctx, artifactId, key);
    }

    async list(
        ctx: Context,
        artifactId: string,
        query: ArtifactDataListQuery = {},
    ): Promise<ArtifactDataPage> {
        return await this.#stores.list(ctx, artifactId, query);
    }

    async changes(
        ctx: Context,
        artifactId: string,
        query: ArtifactDataChangesQuery = {},
    ): Promise<ArtifactDataChanges> {
        return await this.#stores.changes(ctx, artifactId, query);
    }

    async set(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataSetInput,
    ): Promise<ArtifactDataWrite> {
        return await this.#stores.set(ctx, artifactId, input);
    }

    async delete(
        ctx: Context,
        artifactId: string,
        input: ArtifactDataDeleteInput,
    ): Promise<ArtifactDataWrite> {
        return await this.#stores.delete(ctx, artifactId, input);
    }

    subscribe(artifactId: string, listener: ArtifactDataListener): () => void {
        return this.#stores.subscribe(artifactId, listener);
    }

    subscriberCount(artifactId?: string): number {
        return this.#stores.subscriberCount(artifactId);
    }

    /** Keep what the caller's page reported, as the caller; a development page has no version. */
    async appendLogs(
        ctx: Context,
        artifactId: string,
        batch: ArtifactLogBatch,
    ): Promise<{ readonly accepted: number; readonly dropped: number }> {
        return await this.#stores.appendLogs(ctx, artifactId, {
            userId: await this.userId(ctx),
            version: null,
            batch,
        });
    }

    async readLogs(ctx: Context, query: ArtifactLogQuery = {}): Promise<ArtifactLogPage> {
        return await this.#stores.readLogs(ctx, this.artifactId, query);
    }

    async clearLogs(ctx: Context): Promise<void> {
        await this.#stores.discard(ctx, this.artifactId, "logs");
    }

    /** Every entry, tombstones included, in version order, with the people who wrote them. */
    async dump(ctx: Context): Promise<ArtifactDataDump> {
        const entries: ArtifactDataEntry[] = [];
        let since: string | undefined;
        for (;;) {
            const page = await this.#stores.changes(ctx, this.artifactId, {
                ...(since === undefined ? {} : { since }),
                limit: 1_000,
            });
            entries.push(...page.changes);
            if (!page.hasMore || page.cursor === null) break;
            since = page.cursor;
        }
        const ids = [...new Set(entries.map((entry) => entry.updatedBy))];
        const users: ArtifactDataUser[] = [];
        for (let index = 0; index < ids.length; index += 100) {
            users.push(...(await this.users(ctx, this.artifactId, ids.slice(index, index + 100))));
        }
        return {
            format: "happy-artifact-data/1",
            artifactId: this.artifactId,
            entries,
            users: users.map((user) => ({ id: user.id, kind: user.kind, name: user.name })),
        };
    }

    /**
     * Replace the data with a dump's, keeping its versions and authors, and know its people by
     * their names. Every open cursor stops resuming, so pages read the data again.
     */
    async load(ctx: Context, dump: ArtifactDataDump): Promise<void> {
        if (!Value.Check(artifactDataDumpSchema, dump)) {
            throw new ArtifactDataInputError("The data is not an artifact data dump.");
        }
        for (const user of dump.users) {
            if (user.kind !== "user" || this.#users.has(user.id)) continue;
            this.#users.set(user.id, developmentUser(user.id, user.name ?? "Someone"));
        }
        await this.#stores.discard(ctx, this.artifactId, "data");
        await this.#stores.importEntries(ctx, this.artifactId, dump.entries);
    }

    /** Forget every entry, as if nobody had ever written. */
    async reset(ctx: Context): Promise<void> {
        await this.#stores.discard(ctx, this.artifactId, "data");
    }

    async close(ctx: Context): Promise<void> {
        await this.#stores.close(ctx);
    }
}

function developmentUser(id: string, name: string): ArtifactDataUser {
    const [firstName = null, ...rest] = name.split(/\s+/);
    return {
        id,
        kind: "user",
        name,
        firstName,
        lastName: rest.length === 0 ? null : rest.join(" "),
        photoUrl: `/api/v1/users/${id}/photo?v=dev`,
    };
}

/** A round avatar with the person's initials, in a color their ID picks. */
function developmentPhoto(user: ArtifactDataUser): ArtifactDataPhoto {
    const hue = createHash("sha256").update(user.id).digest()[0] ?? 0;
    const initials = (user.name ?? "?")
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0] ?? "")
        .join("")
        .toUpperCase()
        .replace(/[<>&"']/g, "");
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
        `<circle cx="64" cy="64" r="64" fill="hsl(${String(Math.round((hue / 256) * 360))} 55% 50%)"/>` +
        `<text x="64" y="64" dy=".35em" text-anchor="middle" font-family="system-ui, sans-serif" ` +
        `font-size="52" font-weight="600" fill="#fff">${initials}</text></svg>`;
    const bytes = Buffer.from(svg, "utf8");
    return {
        bytes,
        contentType: "image/svg+xml",
        etag: `"${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}"`,
    };
}
