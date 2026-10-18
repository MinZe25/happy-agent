import { Type } from "@sinclair/typebox";

import { mobileDeviceDescriptionSchema } from "../MobileConnector.js";

/** Canonical unpadded base64url of exactly 32 bytes. */
const bytes32Schema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
});

export const handshakeStartRequestSchema = Type.Object(
    { commitment: bytes32Schema, device: mobileDeviceDescriptionSchema },
    { additionalProperties: false },
);

export const handshakeRevealRequestSchema = Type.Object(
    { publicKey: bytes32Schema, nonce: bytes32Schema },
    { additionalProperties: false },
);

export const handshakeConfirmRequestSchema = Type.Object(
    { mac: bytes32Schema },
    { additionalProperties: false },
);

/** `Authorization: Bearer <base64url of 32 bytes>`: every credential the socket accepts. */
export const MOBILE_BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/u;
