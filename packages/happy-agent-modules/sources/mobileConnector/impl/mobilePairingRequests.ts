import { Type } from "@sinclair/typebox";

import { mobileDeviceDescriptionSchema } from "../MobileConnector.js";

/** Canonical unpadded base64url of exactly 32 bytes. */
const bytes32Schema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
});

export const pairingStartRequestSchema = Type.Object(
    { token: bytes32Schema, commitment: bytes32Schema, device: mobileDeviceDescriptionSchema },
    { additionalProperties: false },
);

export const pairingRevealRequestSchema = Type.Object(
    { handshakeId: bytes32Schema, publicKey: bytes32Schema, nonce: bytes32Schema },
    { additionalProperties: false },
);

export const pairingConfirmRequestSchema = Type.Object(
    { handshakeId: bytes32Schema, mac: bytes32Schema },
    { additionalProperties: false },
);

export const pairingRejectRequestSchema = Type.Object(
    { handshakeId: bytes32Schema },
    { additionalProperties: false },
);

export const handshakeIdSchema = bytes32Schema;

/** `Authorization: Bearer <base64url device token>`. */
export const DEVICE_TOKEN_PATTERN = /^Bearer ([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/u;
