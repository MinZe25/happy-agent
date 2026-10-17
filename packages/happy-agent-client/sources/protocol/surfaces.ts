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
import { agentSchema } from "./agents.js";

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

export const surfaceNameSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});

const availableSurfaceTargetFields = {
    state: Type.Literal("available"),
    name: surfaceNameSchema,
    hasImage: Type.Boolean(),
    version: resourceVersionSchema,
};

/** A caller-relative projection; unavailable targets disclose no target identity or metadata. */
export const surfaceTargetSchema = Type.Union([
    Type.Object({
        ...availableSurfaceTargetFields,
        type: Type.Literal("artifact"),
        artifactId: cuid2Schema,
        botId: Type.Optional(Type.Never()),
        taskId: Type.Optional(Type.Never()),
    }),
    Type.Object({
        ...availableSurfaceTargetFields,
        type: Type.Literal("bot"),
        botId: cuid2Schema,
        artifactId: Type.Optional(Type.Never()),
        taskId: Type.Optional(Type.Never()),
    }),
    Type.Object({
        ...availableSurfaceTargetFields,
        type: Type.Literal("task"),
        taskId: cuid2Schema,
        hasImage: Type.Literal(false),
        artifactId: Type.Optional(Type.Never()),
        botId: Type.Optional(Type.Never()),
    }),
    Type.Object({
        type: Type.Union([Type.Literal("artifact"), Type.Literal("bot"), Type.Literal("task")]),
        state: Type.Literal("unavailable"),
        artifactId: Type.Optional(Type.Never()),
        botId: Type.Optional(Type.Never()),
        taskId: Type.Optional(Type.Never()),
        name: Type.Optional(Type.Never()),
        hasImage: Type.Optional(Type.Never()),
        version: Type.Optional(Type.Never()),
    }),
]);
export type SurfaceTarget = Static<typeof surfaceTargetSchema>;

export const surfaceSchema = Type.Object({
    /** One persistent contextual chat, or null before first open; older daemons omit it. */
    chatAgentId: Type.Optional(Nullable(cuid2Schema)),
    /** Immutable creator; null means unattributed or standalone. Older daemons omit it. */
    creatorUserId: Type.Optional(Nullable(userIdSchema)),
    id: surfaceIdSchema,
    image: Nullable(Type.Object({ thumbhash: Type.String() })),
    type: Type.String({ minLength: 1 }),
    members: Type.Array(surfaceMemberSchema),
    name: surfaceNameSchema,
    target: Type.Optional(surfaceTargetSchema),
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
export const createDocumentSurfaceRequestSchema = Type.Object(
    {
        ...surfaceCreationFields,
        image: Type.Optional(surfaceImageInputSchema),
        text: Type.Optional(surfaceDocumentTextSchema),
        type: Type.Literal("document"),
    },
    { additionalProperties: false },
);
export const createCalendarSurfaceRequestSchema = Type.Object(
    {
        ...surfaceCreationFields,
        image: Type.Optional(surfaceImageInputSchema),
        type: Type.Literal("calendar"),
    },
    { additionalProperties: false },
);
export const createArtifactSurfaceRequestSchema = Type.Object(
    {
        ...surfaceCreationFields,
        image: Type.Optional(surfaceImageInputSchema),
        type: Type.Literal("artifact"),
        artifactId: cuid2Schema,
    },
    { additionalProperties: false },
);
export const createBotSurfaceRequestSchema = Type.Object(
    {
        ...surfaceCreationFields,
        image: Type.Optional(surfaceImageInputSchema),
        type: Type.Literal("bot"),
        botId: cuid2Schema,
    },
    { additionalProperties: false },
);
export const createTaskSurfaceRequestSchema = Type.Object(
    {
        ...surfaceCreationFields,
        image: Type.Optional(surfaceImageInputSchema),
        type: Type.Literal("task"),
        taskId: cuid2Schema,
    },
    { additionalProperties: false },
);
export const createSurfaceRequestSchema = Type.Union([
    createTodoSurfaceRequestSchema,
    createDocumentSurfaceRequestSchema,
    createCalendarSurfaceRequestSchema,
    createArtifactSurfaceRequestSchema,
    createBotSurfaceRequestSchema,
    createTaskSurfaceRequestSchema,
]);
export type CreateSurfaceRequest = Static<typeof createSurfaceRequestSchema>;

export const surfaceMemberRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type SurfaceMemberRequest = Static<typeof surfaceMemberRequestSchema>;

export const ensureSurfaceChatRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type EnsureSurfaceChatRequest = Static<typeof ensureSurfaceChatRequestSchema>;

/** A successful ensure always has a ready agent and a non-null association. */
export const surfaceChatResponseSchema = Type.Object({
    agent: agentSchema,
    surface: Type.Object({ ...surfaceSchema.properties, chatAgentId: cuid2Schema }),
});
export type SurfaceChatResponse = Static<typeof surfaceChatResponseSchema>;

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

/** A position in a document's permanent change log; 0 before its first change. */
export const surfaceDocumentSeqSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});
export type SurfaceDocumentSeq = Static<typeof surfaceDocumentSeqSchema>;

/**
 * A document's read-only Markdown projection. Its content version is independent of its catalog
 * Surface version; `seq` is absent on daemons without collaborative documents and on revisions
 * frozen before a document became collaborative.
 */
export const surfaceDocumentSchema = Type.Object({
    authorUserId: Nullable(userIdSchema),
    createdAt: timestampSchema,
    lastEditorUserId: Nullable(userIdSchema),
    seq: Type.Optional(surfaceDocumentSeqSchema),
    surfaceId: surfaceIdSchema,
    text: surfaceDocumentTextSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type SurfaceDocument = Static<typeof surfaceDocumentSchema>;

export const surfaceDocumentSnapshotResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    document: surfaceDocumentSchema,
});
export type SurfaceDocumentSnapshotResponse = Static<typeof surfaceDocumentSnapshotResponseSchema>;

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

const BASE64_PATTERN = "^[A-Za-z0-9+/]*={0,2}$";

/** Standard base64 for Yjs updates, state vectors, and awareness updates. */
const surfaceDocumentBytesSchema = Type.String({ pattern: BASE64_PATTERN });

/** One change: a Yjs update of at most 1 MiB decoded. */
export const surfaceDocumentUpdateBytesSchema = Type.String({
    pattern: BASE64_PATTERN,
    maxLength: 1_398_104,
});

/** Where a change came from. Conversion is the one-time import of an older Markdown document. */
export const surfaceDocumentChangeSourceSchema = Type.Union([
    Type.Literal("api"),
    Type.Literal("tool"),
    Type.Literal("conversion"),
]);
export type SurfaceDocumentChangeSource = Static<typeof surfaceDocumentChangeSourceSchema>;

/** One permanent log entry, without the change bytes. */
export const surfaceDocumentChangeSchema = Type.Object({
    actor: surfaceRevisionActorSchema,
    createdAt: timestampSchema,
    mutationId: Nullable(mutationIdSchema),
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    size: Type.Integer({ minimum: 0 }),
    source: surfaceDocumentChangeSourceSchema,
});
export type SurfaceDocumentChange = Static<typeof surfaceDocumentChangeSchema>;

export const surfaceDocumentChangeListResponseSchema = Type.Object({
    nextAfterSeq: Nullable(surfaceDocumentSeqSchema),
    updates: Type.Array(surfaceDocumentChangeSchema),
});
export type SurfaceDocumentChangeListResponse = Static<
    typeof surfaceDocumentChangeListResponseSchema
>;

/** `GET /state`: the document, or only what a supplied state vector lacks, as one Yjs update. */
export const surfaceDocumentStateResponseSchema = Type.Object({
    seq: surfaceDocumentSeqSchema,
    stateVector: surfaceDocumentBytesSchema,
    update: surfaceDocumentBytesSchema,
});
export type SurfaceDocumentStateResponse = Static<typeof surfaceDocumentStateResponseSchema>;

/** A mutation ID names one change; repeating it returns that change's original `seq`. */
export const sendSurfaceDocumentUpdateRequestSchema = Type.Object(
    { mutationId: mutationIdSchema, update: surfaceDocumentUpdateBytesSchema },
    { additionalProperties: false },
);
export type SendSurfaceDocumentUpdateRequest = Static<
    typeof sendSurfaceDocumentUpdateRequestSchema
>;

export const surfaceDocumentSeqResponseSchema = Type.Object({ seq: surfaceDocumentSeqSchema });
export type SurfaceDocumentSeqResponse = Static<typeof surfaceDocumentSeqResponseSchema>;

/** Subscribes or unsubscribes one event stream, named by its hello `streamId`. */
export const surfaceDocumentSubscriptionRequestSchema = Type.Object(
    { streamId: cuid2Schema },
    { additionalProperties: false },
);
export type SurfaceDocumentSubscriptionRequest = Static<
    typeof surfaceDocumentSubscriptionRequestSchema
>;

/** Relayed to the document's other subscribed streams; never stored. */
export const sendSurfaceDocumentPresenceRequestSchema = Type.Object(
    {
        awarenessClientId: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        streamId: cuid2Schema,
        update: surfaceDocumentUpdateBytesSchema,
    },
    { additionalProperties: false },
);
export type SendSurfaceDocumentPresenceRequest = Static<
    typeof sendSurfaceDocumentPresenceRequestSchema
>;

/** The data of a live `document.update` frame on a subscribed event stream. */
export const surfaceDocumentUpdateFrameSchema = Type.Object({
    actor: surfaceRevisionActorSchema,
    mutationId: Nullable(mutationIdSchema),
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    source: surfaceDocumentChangeSourceSchema,
    surfaceId: surfaceIdSchema,
    update: surfaceDocumentUpdateBytesSchema,
});
export type SurfaceDocumentUpdateFrame = Static<typeof surfaceDocumentUpdateFrameSchema>;

/** The data of a live `document.presence` frame; inactive frames carry no awareness update. */
export const surfaceDocumentPresenceFrameSchema = Type.Object({
    active: Type.Boolean(),
    awarenessClientId: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    clientKey: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    surfaceId: surfaceIdSchema,
    update: Type.Optional(surfaceDocumentUpdateBytesSchema),
});
export type SurfaceDocumentPresenceFrame = Static<typeof surfaceDocumentPresenceFrameSchema>;

/** One live frame from a subscribed event stream: never journaled, never replayed. */
export type SurfaceDocumentLiveFrame =
    | { type: "document.update"; data: SurfaceDocumentUpdateFrame }
    | { type: "document.presence"; data: SurfaceDocumentPresenceFrame };

/** An instant in epoch milliseconds, through the end of year 9999 UTC. */
export const calendarInstantSchema = Type.Integer({ minimum: 0, maximum: 253_402_300_799_999 });

/** A `YYYY-MM-DD` Gregorian date from 1970 through 9999; the daemon rejects impossible days. */
export const calendarDateSchema = Type.String({
    pattern: "^(?:19[7-9][0-9]|[2-9][0-9]{3})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$",
});
export type CalendarDate = Static<typeof calendarDateSchema>;

/** An IANA time zone name; the daemon accepts only names its time zone database recognizes. */
export const calendarTimeZoneSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*$",
});

/** May be empty or blank; clients show their own placeholder. Stored without trimming. */
export const calendarEventTitleSchema = Type.String({
    maxLength: 1024,
    pattern: "^[^\\x00-\\x1f\\x7f]*$",
});
export const calendarEventNotesSchema = Type.String({
    minLength: 1,
    maxLength: 10_000,
    pattern: "^[^\\x00-\\x08\\x0b-\\x1f\\x7f]+$",
});
export const calendarEventLocationSchema = Type.String({
    minLength: 1,
    maxLength: 1024,
    pattern: "^(?=[\\s\\S]*\\S)[^\\x00-\\x1f\\x7f]+$",
});

const calendarTimingVariants = (strict: boolean) => {
    const options = strict ? { additionalProperties: false } : {};
    return [
        Type.Object(
            {
                end: calendarInstantSchema,
                kind: Type.Literal("timed"),
                start: calendarInstantSchema,
                timeZone: calendarTimeZoneSchema,
            },
            options,
        ),
        Type.Object(
            {
                endDate: calendarDateSchema,
                kind: Type.Literal("allDay"),
                startDate: calendarDateSchema,
            },
            options,
        ),
    ] as const;
};

/** Timed events are instants with the zone that gives them wall-clock time; all-day ends exclude. */
export const calendarTimingSchema = Type.Union([...calendarTimingVariants(false)]);
export type CalendarTiming = Static<typeof calendarTimingSchema>;
export const calendarTimingInputSchema = Type.Union([...calendarTimingVariants(true)]);
export type CalendarTimingInput = Static<typeof calendarTimingInputSchema>;

export const calendarWeekdaySchema = Type.Union([
    Type.Literal("monday"),
    Type.Literal("tuesday"),
    Type.Literal("wednesday"),
    Type.Literal("thursday"),
    Type.Literal("friday"),
    Type.Literal("saturday"),
    Type.Literal("sunday"),
]);
export type CalendarWeekday = Static<typeof calendarWeekdaySchema>;

const calendarIntervalSchema = Type.Integer({ minimum: 1, maximum: 1000 });
const calendarCountSchema = Type.Integer({ minimum: 1, maximum: 10_000 });
const calendarWeekdaysSchema = Type.Array(calendarWeekdaySchema, {
    minItems: 1,
    maxItems: 7,
    uniqueItems: true,
});
const otherFrequencySchema = Type.Union([
    Type.Literal("daily"),
    Type.Literal("monthly"),
    Type.Literal("yearly"),
]);

/**
 * Responses carry every field, so a stored rule can be sent back verbatim. Weekly `weekdays: null`
 * means the start's weekday. At most one of `until` and `count` is non-null.
 */
export const calendarRecurrenceSchema = Type.Union([
    Type.Object({
        count: Nullable(calendarCountSchema),
        frequency: Type.Literal("weekly"),
        interval: calendarIntervalSchema,
        until: Nullable(calendarDateSchema),
        weekdays: Nullable(calendarWeekdaysSchema),
    }),
    Type.Object({
        count: Nullable(calendarCountSchema),
        frequency: otherFrequencySchema,
        interval: calendarIntervalSchema,
        until: Nullable(calendarDateSchema),
    }),
]);
export type CalendarRecurrence = Static<typeof calendarRecurrenceSchema>;

/** Requests may omit the defaults: interval 1, weekdays, until, and count null. */
export const calendarRecurrenceInputSchema = Type.Union([
    Type.Object(
        {
            count: Type.Optional(Nullable(calendarCountSchema)),
            frequency: Type.Literal("weekly"),
            interval: Type.Optional(calendarIntervalSchema),
            until: Type.Optional(Nullable(calendarDateSchema)),
            weekdays: Type.Optional(Nullable(calendarWeekdaysSchema)),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            count: Type.Optional(Nullable(calendarCountSchema)),
            frequency: otherFrequencySchema,
            interval: Type.Optional(calendarIntervalSchema),
            until: Type.Optional(Nullable(calendarDateSchema)),
        },
        { additionalProperties: false },
    ),
]);
export type CalendarRecurrenceInput = Static<typeof calendarRecurrenceInputSchema>;

export const calendarEventStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("deleted"),
]);
export type CalendarEventStatus = Static<typeof calendarEventStatusSchema>;

const calendarEventFields = {
    /** Immutable author, distinct from revision actors. */
    authorUserId: Nullable(userIdSchema),
    createdAt: timestampSchema,
    id: cuid2Schema,
    location: Nullable(calendarEventLocationSchema),
    notes: Nullable(calendarEventNotesSchema),
    recurrence: Nullable(calendarRecurrenceSchema),
    surfaceId: surfaceIdSchema,
    timing: calendarTimingSchema,
    title: calendarEventTitleSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

/** One series record. A deleted event is a tombstone that keeps every other field. */
export const calendarEventSchema = Type.Union([
    Type.Object({
        ...calendarEventFields,
        deletedAt: Type.Null(),
        status: Type.Literal("active"),
    }),
    Type.Object({
        ...calendarEventFields,
        deletedAt: timestampSchema,
        status: Type.Literal("deleted"),
    }),
]);
export type CalendarEvent = Static<typeof calendarEventSchema>;

/** One expanded occurrence; its identity is `eventId` with `index` at the event version read. */
export const calendarOccurrenceSchema = Type.Object({
    eventId: cuid2Schema,
    index: Type.Integer({ minimum: 0 }),
    timing: calendarTimingSchema,
});
export type CalendarOccurrence = Static<typeof calendarOccurrenceSchema>;

/** The longest range one read may cover: 100 days. */
export const CALENDAR_RANGE_MAX_MS = 8_640_000_000;
/** The most occurrences one range read returns before reporting `truncated`. */
export const CALENDAR_RANGE_MAX_OCCURRENCES = 5000;

/** Occurrences overlapping `[from, to)`, with exactly the events they belong to. */
export const calendarRangeResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    events: Type.Array(calendarEventSchema),
    occurrences: Type.Array(calendarOccurrenceSchema),
    truncated: Type.Boolean(),
});
export type CalendarRangeResponse = Static<typeof calendarRangeResponseSchema>;

export const calendarEventResponseSchema = Type.Object({ event: calendarEventSchema });
export type CalendarEventResponse = Static<typeof calendarEventResponseSchema>;

export const calendarEventRevisionSchema = Type.Object({
    actor: surfaceRevisionActorSchema,
    event: calendarEventSchema,
    source: surfaceRevisionSourceSchema,
});
export type CalendarEventRevision = Static<typeof calendarEventRevisionSchema>;

export const calendarEventVersionListResponseSchema = Type.Object({
    nextAfterVersion: Nullable(resourceVersionSchema),
    versions: Type.Array(calendarEventRevisionSchema),
});
export type CalendarEventVersionListResponse = Static<
    typeof calendarEventVersionListResponseSchema
>;

export const calendarEventVersionResponseSchema = Type.Object({
    revision: calendarEventRevisionSchema,
});
export type CalendarEventVersionResponse = Static<typeof calendarEventVersionResponseSchema>;

export const createCalendarEventRequestSchema = Type.Object(
    {
        id: Type.Optional(cuid2Schema),
        location: Type.Optional(Nullable(calendarEventLocationSchema)),
        mutationId: Type.Optional(mutationIdSchema),
        notes: Type.Optional(Nullable(calendarEventNotesSchema)),
        recurrence: Type.Optional(Nullable(calendarRecurrenceInputSchema)),
        timing: calendarTimingInputSchema,
        title: Type.Optional(calendarEventTitleSchema),
    },
    { additionalProperties: false },
);
export type CreateCalendarEventRequest = Static<typeof createCalendarEventRequestSchema>;

const calendarEventEdits = {
    location: Nullable(calendarEventLocationSchema),
    notes: Nullable(calendarEventNotesSchema),
    recurrence: Nullable(calendarRecurrenceInputSchema),
    status: calendarEventStatusSchema,
    timing: calendarTimingInputSchema,
    title: calendarEventTitleSchema,
};
const optionalCalendarEventEdits = {
    location: Type.Optional(calendarEventEdits.location),
    mutationId: Type.Optional(mutationIdSchema),
    notes: Type.Optional(calendarEventEdits.notes),
    recurrence: Type.Optional(calendarEventEdits.recurrence),
    status: Type.Optional(calendarEventEdits.status),
    timing: Type.Optional(calendarEventEdits.timing),
    title: Type.Optional(calendarEventEdits.title),
};
const strict = { additionalProperties: false } as const;

/**
 * Any non-empty subset of the editable fields; a mutation echo alone is not an edit. `timing`
 * and `recurrence` replace the whole value, so a revision's fields restore it exactly.
 */
export const updateCalendarEventRequestSchema = Type.Union([
    Type.Object({ ...optionalCalendarEventEdits, title: calendarEventEdits.title }, strict),
    Type.Object({ ...optionalCalendarEventEdits, notes: calendarEventEdits.notes }, strict),
    Type.Object({ ...optionalCalendarEventEdits, location: calendarEventEdits.location }, strict),
    Type.Object({ ...optionalCalendarEventEdits, timing: calendarEventEdits.timing }, strict),
    Type.Object(
        { ...optionalCalendarEventEdits, recurrence: calendarEventEdits.recurrence },
        strict,
    ),
    Type.Object({ ...optionalCalendarEventEdits, status: calendarEventEdits.status }, strict),
]);
export type UpdateCalendarEventRequest = Static<typeof updateCalendarEventRequestSchema>;

/** Delete accepts this optional echo-only body. */
export const calendarEventMutationRequestSchema = surfaceMemberRequestSchema;
export type CalendarEventMutationRequest = Static<typeof calendarEventMutationRequestSchema>;
