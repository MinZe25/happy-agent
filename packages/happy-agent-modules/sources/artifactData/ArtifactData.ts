import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;

/** Every byte a key, a value, and a request may hold, and how much one store may keep. */
export const ARTIFACT_DATA_LIMITS = {
    /** A key's length in characters. */
    keyLength: 512,
    /** One value, serialized as JSON in UTF-8. */
    valueBytes: 256 * 1024,
    /** One request body. */
    requestBytes: 1024 * 1024,
    /** Every live key and value of one store together. */
    storeBytes: 64 * 1024 * 1024,
    /** Live keys in one store. */
    storeKeys: 100_000,
    /** Entries in one list page, and changes in one changes page. */
    pageSize: 1_000,
    /** How long a repeated `writeId` answers with its first result. */
    writeRetentionMs: 24 * 60 * 60 * 1000,
    /** How long a deleted key's tombstone is kept for clients catching up. */
    tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_ARTIFACT_DATA_PAGE_SIZE = 100;

export const artifactDataVersionSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export type ArtifactDataVersion = Static<typeof artifactDataVersionSchema>;

/** 1–512 characters with no control characters; `/` is an ordinary character for prefixes. */
export const artifactDataKeySchema = Type.String({
    minLength: 1,
    maxLength: ARTIFACT_DATA_LIMITS.keyLength,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

/** A key prefix; empty matches every key. */
export const artifactDataPrefixSchema = Type.String({
    maxLength: ARTIFACT_DATA_LIMITS.keyLength,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]*$",
});

/** A client-chosen idempotency key for one write. */
export const artifactDataWriteIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9_.:-]+$",
});

/**
 * Who wrote or is looking, as a page knows them: a team member's Happy user ID, the standalone
 * person's stable ID, or an agent's stable ID, which is never the agent's own.
 */
export const artifactDataUserIdSchema = cuid2Schema;

/** Who is making a write: an authenticated person, or an agent through its tools. */
export const artifactDataAuthorSchema = Type.Union([
    Type.Object({ kind: Type.Literal("user"), userId: cuid2Schema }, exact),
    Type.Object({ kind: Type.Literal("agent"), agentId: cuid2Schema }, exact),
]);
export type ArtifactDataAuthor = Static<typeof artifactDataAuthorSchema>;

/** One key as it is now: live with its value, or a tombstone left by a deletion. */
export const artifactDataEntrySchema = Type.Object(
    {
        key: artifactDataKeySchema,
        value: Type.Unknown(),
        deleted: Type.Boolean(),
        version: artifactDataVersionSchema,
        updatedBy: artifactDataUserIdSchema,
        updatedAt: Type.Integer({ minimum: 0 }),
        writeId: Type.Union([artifactDataWriteIdSchema, Type.Null()]),
    },
    exact,
);
export type ArtifactDataEntry = Static<typeof artifactDataEntrySchema>;

export const artifactDataListQuerySchema = Type.Object(
    {
        prefix: Type.Optional(artifactDataPrefixSchema),
        after: Type.Optional(artifactDataKeySchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ARTIFACT_DATA_LIMITS.pageSize })),
    },
    exact,
);
export type ArtifactDataListQuery = Static<typeof artifactDataListQuerySchema>;

export const artifactDataChangesQuerySchema = Type.Object(
    {
        since: Type.Optional(artifactDataVersionSchema),
        prefix: Type.Optional(artifactDataPrefixSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ARTIFACT_DATA_LIMITS.pageSize })),
    },
    exact,
);
export type ArtifactDataChangesQuery = Static<typeof artifactDataChangesQuerySchema>;

/** A write's preconditions: the key's current version, or that the key holds no value. */
export const artifactDataConditionSchema = Type.Union([
    Type.Object({ ifVersion: artifactDataVersionSchema }, exact),
    Type.Object({ ifAbsent: Type.Literal(true) }, exact),
]);
export type ArtifactDataCondition = Static<typeof artifactDataConditionSchema>;

export const artifactDataSetInputSchema = Type.Object(
    {
        key: artifactDataKeySchema,
        value: Type.Unknown(),
        author: artifactDataAuthorSchema,
        writeId: Type.Optional(artifactDataWriteIdSchema),
        condition: Type.Optional(artifactDataConditionSchema),
    },
    exact,
);
export type ArtifactDataSetInput = Static<typeof artifactDataSetInputSchema>;

export const artifactDataDeleteInputSchema = Type.Object(
    {
        key: artifactDataKeySchema,
        author: artifactDataAuthorSchema,
        writeId: Type.Optional(artifactDataWriteIdSchema),
        condition: Type.Optional(artifactDataConditionSchema),
    },
    exact,
);
export type ArtifactDataDeleteInput = Static<typeof artifactDataDeleteInputSchema>;

/** One page of live entries in key order, read in one snapshot with the store's cursor. */
export interface ArtifactDataPage {
    readonly entries: readonly ArtifactDataEntry[];
    readonly nextAfter: string | undefined;
    readonly cursor: ArtifactDataVersion | null;
}

/** Changes after a cursor in version order: each key at most once, as it is now. */
export interface ArtifactDataChanges {
    readonly changes: readonly ArtifactDataEntry[];
    readonly cursor: ArtifactDataVersion | null;
    readonly hasMore: boolean;
}

export interface ArtifactDataWrite {
    /** The entry as this write left it. */
    readonly entry: ArtifactDataEntry;
    /** `true` when a repeated `writeId` answered with its first result and changed nothing. */
    readonly replayed: boolean;
}

/** What a subscriber hears: a committed change, or that its store no longer serves anyone. */
export type ArtifactDataSignal =
    | { readonly type: "change"; readonly entry: ArtifactDataEntry }
    | { readonly type: "closed"; readonly reason: "artifact_deleted" | "shutdown" };

export type ArtifactDataListener = (signal: ArtifactDataSignal) => void;

/**
 * A person, or an agent that wrote through its tools, as an artifact page sees them; never an
 * email, an external identity, or an agent's own ID.
 */
export interface ArtifactDataUser {
    readonly id: string;
    readonly kind: "user" | "agent";
    readonly name: string | null;
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly photoUrl: string | null;
}

export interface ArtifactDataPhoto {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly etag: string;
}

/** The artifact does not exist, or it was deleted, so it has no data to serve. */
export class ArtifactDataNotFoundError extends Error {
    constructor(message = "The artifact was not found.") {
        super(message);
        this.name = "ArtifactDataNotFoundError";
    }
}

export class ArtifactDataInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ArtifactDataInputError";
    }
}

/** A value or the store as a whole would exceed its limit. */
export class ArtifactDataTooLargeError extends Error {
    readonly code: "too_large" | "storage_full";

    constructor(code: "too_large" | "storage_full", message: string) {
        super(message);
        this.name = "ArtifactDataTooLargeError";
        this.code = code;
    }
}

/** A write's condition did not hold; it carries the key as it is now, or `null`. */
export class ArtifactDataConflictError extends Error {
    readonly entry: ArtifactDataEntry | null;

    constructor(entry: ArtifactDataEntry | null, message = "The key has changed.") {
        super(message);
        this.name = "ArtifactDataConflictError";
        this.entry = entry;
    }
}

/** A cursor older than the tombstones still kept, or newer than the store: start over. */
export class ArtifactDataCursorUnavailableError extends Error {
    constructor(message = "The cursor is no longer available; read the store again.") {
        super(message);
        this.name = "ArtifactDataCursorUnavailableError";
    }
}
