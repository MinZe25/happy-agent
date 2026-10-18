/**
 * The mobile connector, seen from the desktop: the connector's socket, the caller's pairing with
 * its QR code and emoji, and the caller's paired phones. Phones pair and then use this same API
 * over the connector's own socket; this client implements none of the phone's side.
 */

import { type Static, Type } from "@sinclair/typebox";

import { cuid2Schema, Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

/** The connector's socket: off by configuration, closed while unused, or opening, open, failed. */
export const mobileConnectorStatusSchema = Type.Union([
    Type.Literal("disabled"),
    Type.Literal("closed"),
    Type.Literal("starting"),
    Type.Literal("open"),
    Type.Literal("failed"),
]);
export type MobileConnectorStatus = Static<typeof mobileConnectorStatusSchema>;

export const mobilePairingStatusSchema = Type.Union([
    Type.Literal("waiting"),
    Type.Literal("verifying"),
    Type.Literal("completed"),
    Type.Literal("rejected"),
    Type.Literal("expired"),
    Type.Literal("cancelled"),
    Type.Literal("failed"),
]);
export type MobilePairingStatus = Static<typeof mobilePairingStatusSchema>;

export const mobileDevicePlatformSchema = Type.Union([
    Type.Literal("ios"),
    Type.Literal("android"),
    Type.Literal("other"),
]);
export type MobileDevicePlatform = Static<typeof mobileDevicePlatformSchema>;

/** How a phone described itself. The phone chose these values: display them, trust nothing. */
export const mobileDeviceDescriptionSchema = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 128 }),
    platform: mobileDevicePlatformSchema,
});
export type MobileDeviceDescription = Static<typeof mobileDeviceDescriptionSchema>;

/** One of the caller's paired phones. */
export const mobileDeviceSchema = Type.Object({
    id: cuid2Schema,
    name: Type.String({ minLength: 1, maxLength: 128 }),
    platform: mobileDevicePlatformSchema,
    /** When pairing completed. */
    createdAt: timestampSchema,
    /** Starts at `createdAt`; moves forward at most once a minute as the phone uses its token. */
    lastSeenAt: timestampSchema,
});
export type MobileDevice = Static<typeof mobileDeviceSchema>;

/** The caller's current or most recent pairing. A finished one stays until the next start or cancel. */
export const mobilePairingSchema = Type.Object({
    id: cuid2Schema,
    status: mobilePairingStatusSchema,
    /**
     * The `happy://direct?…` text to show as a QR code while it can still be used. It holds a
     * one-time secret and the socket's secret address: show it on screen, never log or store it.
     */
    qr: Nullable(Type.String({ minLength: 1 })),
    /** Five minutes after the pairing started; both confirmations must come before it. */
    expiresAt: timestampSchema,
    device: Nullable(mobileDeviceDescriptionSchema),
    /** The four emoji to compare, from `verifying` on; show them exactly as given. */
    emoji: Nullable(Type.Array(Type.String(), { minItems: 4, maxItems: 4 })),
    desktopConfirmed: Type.Boolean(),
    mobileConfirmed: Type.Boolean(),
    /** An English message for a `failed` pairing. */
    error: Nullable(Type.String({ minLength: 1 })),
});
export type MobilePairing = Static<typeof mobilePairingSchema>;

/** The mobile connector object: one caller's complete view, versioned by a UUIDv7. */
export const mobileConnectorSchema = Type.Object({
    status: mobileConnectorStatusSchema,
    pairing: Nullable(mobilePairingSchema),
    /** Oldest first. */
    devices: Type.Array(mobileDeviceSchema),
    /** An English message while `status` is `failed`. */
    error: Nullable(Type.String({ minLength: 1 })),
    /** Keep the snapshot with the greater version. */
    version: resourceVersionSchema,
    updatedAt: timestampSchema,
});
export type MobileConnector = Static<typeof mobileConnectorSchema>;

/** Every mobile connector route answers with the caller's complete snapshot. */
export const mobileConnectorResponseSchema = Type.Object({
    mobileConnector: mobileConnectorSchema,
});
export type MobileConnectorResponse = Static<typeof mobileConnectorResponseSchema>;

/** `POST /v0/mobile-connector/pairing/confirm` and `/cancel`. */
export const mobilePairingRequestSchema = Type.Object({ pairingId: cuid2Schema });
export type MobilePairingRequest = Static<typeof mobilePairingRequestSchema>;
