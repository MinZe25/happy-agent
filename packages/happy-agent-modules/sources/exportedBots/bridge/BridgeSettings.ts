import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";

export const BRIDGE_KIND = "bridge";

/** Printable text, for a service's name. */
export const BRIDGE_SERVICE_PATTERN = "^[^\\u0000-\\u001f\\u007f-\\u009f]+$";

/** The chat service a bridge connects, as people know it, such as "Slack". */
export const bridgeServiceSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: BRIDGE_SERVICE_PATTERN,
});

/**
 * A bridge export's stored settings. Only the token's SHA-256 is kept; the token itself exists
 * only in the file the setup tool wrote.
 */
export const bridgeSettingsSchema = Type.Object(
    {
        service: bridgeServiceSchema,
        tokenHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
);
export type BridgeSettings = Static<typeof bridgeSettingsSchema>;

/**
 * `heb1.<account>.<secret>`: the export's public account ID, so a presented token finds its
 * export without a search, and 256 random bits. The account stays the same when the token is
 * rotated, so conversations survive rotation.
 */
const TOKEN_PATTERN = /^heb1\.([a-z0-9]{2,32})\.([A-Za-z0-9_-]{43})$/;

/** A new account ID for a new bridge export. */
export function newBridgeAccount(): string {
    return createId();
}

export function newBridgeToken(account: string): string {
    return `heb1.${account}.${randomBytes(32).toString("base64url")}`;
}

export function bridgeTokenHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** The account a token names, or undefined when it is not a bridge token. */
export function bridgeTokenAccount(token: string): string | undefined {
    return TOKEN_PATTERN.exec(token)?.[1];
}

/** Whether `token` is the one `settings` were made for, in constant time. */
export function bridgeTokenMatches(settings: BridgeSettings, token: string): boolean {
    const presented = Buffer.from(bridgeTokenHash(token), "hex");
    const expected = Buffer.from(settings.tokenHash, "hex");
    return presented.length === expected.length && timingSafeEqual(presented, expected);
}
