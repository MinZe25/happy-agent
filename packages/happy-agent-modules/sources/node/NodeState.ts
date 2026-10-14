import { Type, type Static } from "@sinclair/typebox";
import { nodeNameSchema } from "@slopus/happy-agent-client";

import { MAX_MANAGED_IMAGE_BYTES } from "../impl/images/normalizeManagedImage.js";
export const MAX_NODE_AVATAR_BYTES = MAX_MANAGED_IMAGE_BYTES;

export const nodeAvatarAssetSchema = Type.Object(
    {
        data: Type.String({ minLength: 1, maxLength: Math.ceil(MAX_NODE_AVATAR_BYTES / 3) * 4 }),
        thumbhash: Type.String({ minLength: 1, maxLength: 128 }),
        etag: Type.String({ pattern: '^"[0-9a-f]{64}"$' }),
    },
    { additionalProperties: false },
);
export type NodeAvatarAsset = Static<typeof nodeAvatarAssetSchema>;

export const nodeStateSchema = Type.Object(
    {
        name: nodeNameSchema,
        avatar: Type.Union([nodeAvatarAssetSchema, Type.Null()]),
    },
    { additionalProperties: false },
);
export type NodeState = Static<typeof nodeStateSchema>;
