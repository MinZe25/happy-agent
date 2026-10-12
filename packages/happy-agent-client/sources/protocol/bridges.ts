/**
 * Local bridges: a USB device, a Bluetooth adapter, or a local TCP service on the person's own
 * computer, reaching a workspace's machine. A bridge lives exactly as long as the client-held
 * WebSocket that opened it; nothing about it is durable.
 */
import { Type, type Static } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";

/** Why a capability is unavailable, or why a bridge closed. Clients branch on `code`. */
export const workspaceBridgeReasonSchema = Type.Object({
    code: Type.String(),
    message: Type.String(),
});
export type WorkspaceBridgeReason = Static<typeof workspaceBridgeReasonSchema>;

/** The unavailability codes the specification names today; unknown codes mean unavailable. */
export const WORKSPACE_BRIDGE_UNAVAILABLE_CODES = [
    "unsupported_platform",
    "vhci_not_loaded",
    "vhci_missing",
    "permission_denied",
    "bluetooth_driver_missing",
    "container_compute",
    "runner_compute",
] as const;
export type WorkspaceBridgeUnavailableCode = (typeof WORKSPACE_BRIDGE_UNAVAILABLE_CODES)[number];

/** The close reasons the specification names today. */
export const WORKSPACE_BRIDGE_CLOSE_REASON_CODES = [
    "client_closed",
    "closed_by_request",
    "workspace_archived",
    "daemon_shutdown",
    "device_detached",
    "failed",
] as const;
export type WorkspaceBridgeCloseReasonCode = (typeof WORKSPACE_BRIDGE_CLOSE_REASON_CODES)[number];

/** Available with `reason: null`, or unavailable with a reason. */
export const workspaceBridgeCapabilitySchema = Type.Object({
    available: Type.Boolean(),
    reason: Nullable(workspaceBridgeReasonSchema),
});
export type WorkspaceBridgeCapability = Static<typeof workspaceBridgeCapabilitySchema>;

/** Bluetooth additionally names how it is carried; `"usb"` is the only value today. */
export const workspaceBluetoothCapabilitySchema = Type.Object({
    available: Type.Boolean(),
    transport: Type.String(),
    reason: Nullable(workspaceBridgeReasonSchema),
});
export type WorkspaceBluetoothCapability = Static<typeof workspaceBluetoothCapabilitySchema>;

export const workspaceBridgeCapabilitiesSchema = Type.Object({
    usb: workspaceBridgeCapabilitySchema,
    bluetooth: workspaceBluetoothCapabilitySchema,
    localToWorkspace: workspaceBridgeCapabilitySchema,
    workspaceToLocal: workspaceBridgeCapabilitySchema,
});
export type WorkspaceBridgeCapabilities = Static<typeof workspaceBridgeCapabilitiesSchema>;

export const workspaceBridgeKindSchema = Type.Union([Type.Literal("usb"), Type.Literal("port")]);
export type WorkspaceBridgeKind = Static<typeof workspaceBridgeKindSchema>;

export const workspaceBridgeStatusSchema = Type.Union([
    Type.Literal("open"),
    Type.Literal("closed"),
]);
export type WorkspaceBridgeStatus = Static<typeof workspaceBridgeStatusSchema>;

/** A device's bus ID as the client's USB/IP exporter names it. */
export const workspaceUsbBusIdSchema = Type.String({ pattern: "^[0-9A-Za-z._:-]{1,31}$" });

export const workspaceUsbSpeedSchema = Type.Union([
    Type.Literal("low"),
    Type.Literal("full"),
    Type.Literal("high"),
    Type.Literal("wireless"),
    Type.Literal("super"),
    Type.Literal("super_plus"),
]);
export type WorkspaceUsbSpeed = Static<typeof workspaceUsbSpeedSchema>;

const usbIdentifierSchema = Type.String({ pattern: "^[0-9a-f]{4}$" });
const usbClassSchema = Type.Integer({ minimum: 0, maximum: 255 });

/** The device as its exporter described it, and the virtual port it occupies. */
export const workspaceUsbBridgeDeviceSchema = Type.Object({
    busId: workspaceUsbBusIdSchema,
    vendorId: usbIdentifierSchema,
    productId: usbIdentifierSchema,
    deviceClass: usbClassSchema,
    deviceSubclass: usbClassSchema,
    deviceProtocol: usbClassSchema,
    speed: workspaceUsbSpeedSchema,
    port: Type.Integer({ minimum: 0 }),
});
export type WorkspaceUsbBridgeDevice = Static<typeof workspaceUsbBridgeDeviceSchema>;

/** Where programs on the workspace's machine connect. */
export const workspacePortBridgeListenerSchema = Type.Object({
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
});
export type WorkspacePortBridgeListener = Static<typeof workspacePortBridgeListenerSchema>;

export const workspaceBridgeNameSchema = Type.String({ minLength: 1, maxLength: 128 });

export const workspaceBridgeSchema = Type.Object({
    id: cuid2Schema,
    workspaceId: cuid2Schema,
    kind: workspaceBridgeKindSchema,
    name: workspaceBridgeNameSchema,
    status: workspaceBridgeStatusSchema,
    usb: Nullable(workspaceUsbBridgeDeviceSchema),
    port: Nullable(workspacePortBridgeListenerSchema),
    closeReason: Nullable(workspaceBridgeReasonSchema),
    version: resourceVersionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    closedAt: Nullable(timestampSchema),
});
export type WorkspaceBridge = Static<typeof workspaceBridgeSchema>;

/** `GET /v0/workspaces/:workspaceId/bridges` */
export const workspaceBridgeListResponseSchema = Type.Object({
    capabilities: workspaceBridgeCapabilitiesSchema,
    bridges: Type.Array(workspaceBridgeSchema),
    cursor: eventCursorSchema,
});
export type WorkspaceBridgeListResponse = Static<typeof workspaceBridgeListResponseSchema>;

export const workspaceBridgeResponseSchema = Type.Object({ bridge: workspaceBridgeSchema });
export type WorkspaceBridgeResponse = Static<typeof workspaceBridgeResponseSchema>;

/** `DELETE /v0/workspaces/:workspaceId/bridges/:bridgeId` */
export const closeWorkspaceBridgeRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type CloseWorkspaceBridgeRequest = Static<typeof closeWorkspaceBridgeRequestSchema>;

/** Query of the `GET /v0/workspaces/:workspaceId/bridges/usb` WebSocket upgrade. */
export const workspaceUsbBridgeQuerySchema = Type.Object({
    busId: workspaceUsbBusIdSchema,
    id: Type.Optional(cuid2Schema),
    name: Type.Optional(workspaceBridgeNameSchema),
});
export type WorkspaceUsbBridgeQuery = Static<typeof workspaceUsbBridgeQuerySchema>;

/** Query of the `GET /v0/workspaces/:workspaceId/bridges/port` WebSocket upgrade. */
export const workspacePortBridgeQuerySchema = Type.Object({
    /** `0` lets the daemon choose. */
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
    id: Type.Optional(cuid2Schema),
    name: Type.Optional(workspaceBridgeNameSchema),
});
export type WorkspacePortBridgeQuery = Static<typeof workspacePortBridgeQuerySchema>;

/** What the daemon sends on a port bridge's control WebSocket, as JSON text messages. */
export const workspacePortBridgeServerMessageSchema = Type.Union([
    Type.Object({ type: Type.Literal("ready"), bridge: workspaceBridgeSchema }),
    Type.Object({ type: Type.Literal("connection"), connectionId: cuid2Schema }),
]);
export type WorkspacePortBridgeServerMessage = Static<
    typeof workspacePortBridgeServerMessageSchema
>;

/** What the client may send on a port bridge's control WebSocket. */
export const workspacePortBridgeClientMessageSchema = Type.Object({
    type: Type.Literal("reject"),
    connectionId: cuid2Schema,
});
export type WorkspacePortBridgeClientMessage = Static<
    typeof workspacePortBridgeClientMessageSchema
>;

/** WebSocket close codes on every bridge WebSocket. */
export const WORKSPACE_BRIDGE_CLOSE_CODES = {
    /** The client, `DELETE`, archival, or the device or listener ended the bridge. */
    normal: 1000,
    /** The daemon is shutting down. */
    shutdown: 1001,
    /** An internal failure. */
    internal: 1011,
    /** A protocol violation, such as a text message on a binary WebSocket. */
    protocolViolation: 4400,
    /** The USB/IP exporter refused or misidentified the device. */
    deviceRefused: 4404,
    /** The USB/IP import deadline passed. */
    importTimeout: 4408,
    /** No virtual host controller port of the needed speed is free. */
    noFreePort: 4409,
    /** The kernel refused the attachment. */
    kernelRefused: 4502,
} as const;

/** The largest binary message on a bridge WebSocket. */
export const WORKSPACE_BRIDGE_MAX_BINARY_MESSAGE_BYTES = 1024 * 1024;
/** The largest JSON text message on a port bridge's control WebSocket. */
export const WORKSPACE_BRIDGE_MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;

export const workspaceBridgeCreatedPayloadSchema = Type.Object({
    bridge: workspaceBridgeSchema,
});
export type WorkspaceBridgeCreatedPayload = Static<typeof workspaceBridgeCreatedPayloadSchema>;

export const workspaceBridgeChangesSchema = Type.Object({
    ...Type.Partial(Type.Pick(workspaceBridgeSchema, ["status", "closeReason", "closedAt"]))
        .properties,
    updatedAt: timestampSchema,
});
export type WorkspaceBridgeChanges = Static<typeof workspaceBridgeChangesSchema>;

export const workspaceBridgeUpdatedPayloadSchema = Type.Object({
    bridgeId: cuid2Schema,
    workspaceId: cuid2Schema,
    previousVersion: resourceVersionSchema,
    version: resourceVersionSchema,
    changes: workspaceBridgeChangesSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type WorkspaceBridgeUpdatedPayload = Static<typeof workspaceBridgeUpdatedPayloadSchema>;

/** An invalidation: reread the capabilities shown. */
export const workspaceBridgeCapabilitiesUpdatedPayloadSchema = Type.Object({});
export type WorkspaceBridgeCapabilitiesUpdatedPayload = Static<
    typeof workspaceBridgeCapabilitiesUpdatedPayloadSchema
>;
