import { Type, type Static } from "@sinclair/typebox";

const MIB = 1024 * 1024;

/** How many items one call may show. */
export const MAX_CHAT_MEDIA_ITEMS = 10;
/** The largest image, video, and other file one item may be, by kind. */
export const MAX_CHAT_MEDIA_IMAGE_BYTES = 32 * MIB;
export const MAX_CHAT_MEDIA_VIDEO_BYTES = 256 * MIB;
export const MAX_CHAT_MEDIA_FILE_BYTES = 64 * MIB;
/** The most one call may present in all. */
export const MAX_CHAT_MEDIA_CALL_BYTES = 256 * MIB;

const itemFields = {
    /** The file's base name, for display and downloads only. */
    name: Type.String({ minLength: 1, maxLength: 255 }),
    mimeType: Type.String({ minLength: 1, maxLength: 255 }),
    size: Type.Integer({ minimum: 0 }),
    /** Names the private snapshot the bytes are served from. */
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
};

/** One snapshotted item: a decoded, measured image, or any other file. */
export const chatMediaItemSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("image"),
            ...itemFields,
            width: Type.Integer({ minimum: 1 }),
            height: Type.Integer({ minimum: 1 }),
            thumbhash: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Union([
                Type.Literal("video"),
                Type.Literal("document"),
                Type.Literal("file"),
            ]),
            ...itemFields,
        },
        { additionalProperties: false },
    ),
]);

export type ChatMediaItem = Static<typeof chatMediaItemSchema>;

/** What a tool result carries so History records the items with the call that showed them. */
export const chatMediaPresentationSchema = Type.Object(
    {
        type: Type.Literal("media"),
        items: Type.Array(chatMediaItemSchema, { minItems: 1, maxItems: MAX_CHAT_MEDIA_ITEMS }),
    },
    { additionalProperties: false },
);

export type ChatMediaPresentation = Static<typeof chatMediaPresentationSchema>;

/** Where one presented item's bytes are kept, for a route serving them. */
export interface ChatMediaStoredItem {
    readonly item: ChatMediaItem;
    readonly contentPath: string;
}
