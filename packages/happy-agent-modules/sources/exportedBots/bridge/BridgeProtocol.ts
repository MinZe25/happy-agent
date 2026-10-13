import { Type, type Static } from "@sinclair/typebox";

import { serviceIdSchema, MAX_EXPORTED_BOT_REPLY_CHARACTERS } from "../ExportedBot.js";
import { MAX_INBOUND_ATTACHMENTS } from "../impl/readInboundAttachments.js";

/** The protocol versions this daemon speaks, as `?protocol=` names them. */
export const BRIDGE_PROTOCOLS = ["1"] as const;
export const BRIDGE_PROTOCOL_VERSION = 1;

/** A bridge keeps at most this many messages unanswered. */
export const MAX_UNANSWERED_MESSAGES = 64;
/** Replies waiting for a bridge's acknowledgement; the oldest are dropped beyond it. */
export const MAX_WAITING_REPLIES = 1_000;
/** How often the daemon pings a bridge. One that misses a ping is dropped. */
export const PING_INTERVAL_MS = 30_000;

/** Close codes the daemon uses, beyond the standard ones. */
export const CLOSE_REPLACED = 4000;
export const CLOSE_CHANGED = 4001;
export const CLOSE_UNAVAILABLE = 4002;

/** One file a person sent, as a path on this machine the bridge wrote. */
export const inboundAttachmentFrameSchema = Type.Object({
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});

/** One thing a person said, from the bridge. Unknown fields are ignored. */
export const messageFrameSchema = Type.Object({
    type: Type.Literal("message"),
    id: serviceIdSchema,
    userId: serviceIdSchema,
    chatId: serviceIdSchema,
    name: Type.Optional(Type.String({ maxLength: 256 })),
    username: Type.Optional(Type.String({ maxLength: 64 })),
    text: Type.Optional(Type.String({ maxLength: MAX_EXPORTED_BOT_REPLY_CHARACTERS })),
    attachments: Type.Optional(
        Type.Array(inboundAttachmentFrameSchema, { maxItems: MAX_INBOUND_ATTACHMENTS }),
    ),
});
export type MessageFrame = Static<typeof messageFrameSchema>;

/** The bridge is finished with one reply. */
export const ackFrameSchema = Type.Object({
    type: Type.Literal("ack"),
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});

/** Every frame has a string type; anything else about an unknown type is ignored. */
export const frameSchema = Type.Object({ type: Type.String({ maxLength: 64 }) });
