import { cuid2Schema } from "@slopus/happy-agent-base";
import {
    workspaceUsbBusIdSchema,
    type WorkspaceBridgeCapabilitiesUpdatedPayload,
    type WorkspaceBridgeCloseReasonCode,
    type WorkspaceBridgeCreatedPayload,
    type WorkspaceBridgeReason,
    type WorkspaceBridgeUpdatedPayload,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/** At most this many USB bridges are attached or attaching on one daemon. */
export const MAX_USB_BRIDGES = 32;
/** At most this many port bridges listen on one workspace. */
export const MAX_PORT_BRIDGES_PER_WORKSPACE = 32;
/** At most this many port bridges listen on one daemon. */
export const MAX_PORT_BRIDGES = 256;
/** At most this many connections of one port bridge are open, waiting ones included. */
export const MAX_PORT_BRIDGE_CONNECTIONS = 256;
/** At most this many connections of one port bridge wait to be accepted. */
export const MAX_PORT_BRIDGE_WAITING_CONNECTIONS = 64;
/** A waiting connection nobody accepted in this long is closed. */
export const PORT_BRIDGE_ACCEPT_TIMEOUT_MS = 30_000;
/** An exporter that has not answered the import in this long is given up on. */
export const USB_IMPORT_TIMEOUT_MS = 10_000;

/** A display name: 1–128 characters, none of them a control character. */
export const bridgeNameSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

/** What a client asks for when it opens a USB bridge. */
export const usbBridgeRequestSchema = Type.Object(
    {
        busId: workspaceUsbBusIdSchema,
        id: Type.Optional(cuid2Schema),
        name: Type.Optional(bridgeNameSchema),
    },
    { additionalProperties: false },
);
export type UsbBridgeRequest = Static<typeof usbBridgeRequestSchema>;

/** What a client asks for when it opens a port bridge. `port: 0` lets the daemon choose. */
export const portBridgeRequestSchema = Type.Object(
    {
        port: Type.Integer({ minimum: 0, maximum: 65535 }),
        id: Type.Optional(cuid2Schema),
        name: Type.Optional(bridgeNameSchema),
    },
    { additionalProperties: false },
);
export type PortBridgeRequest = Static<typeof portBridgeRequestSchema>;

export type BridgeErrorCode =
    | "invalid_request"
    | "not_found"
    | "not_initialized"
    | "conflict"
    | "bridge_unavailable"
    | "bridge_limit"
    | "port_unavailable"
    | "unavailable";

/** A refusal a caller turns into a status. `reason` explains an unavailable capability. */
export class BridgeError extends Error {
    override readonly name = "BridgeError";

    constructor(
        readonly code: BridgeErrorCode,
        message: string,
        readonly reason?: WorkspaceBridgeReason,
    ) {
        super(message);
    }
}

/**
 * One bridge WebSocket, as the server that upgraded it presents it.
 *
 * A bridge never reaches past this: it does not know whether Node or Bun accepted the WebSocket.
 */
export interface BridgeWebSocket {
    /** Bytes sent and not yet written to the client. */
    readonly bufferedAmount: number;
    /** Sends one binary message for bytes, or one text message for a string. */
    send(data: Uint8Array | string): void;
    close(code: number, reason: string): void;
    /** Stops reading the client's messages, where the server can. */
    pause?(): void;
    resume?(): void;
}

/** What the server tells a bridge about its WebSocket. */
export interface BridgeWebSocketBinding {
    /** One message: bytes for a binary message, a string for a text message. */
    message(data: Uint8Array | string): void;
    /** The WebSocket closed, for whatever reason. */
    closed(): void;
}

/** An upgrade the module has admitted and reserved room for. */
export interface BridgeAdmission {
    /** Takes the upgraded WebSocket. */
    attach(webSocket: BridgeWebSocket): BridgeWebSocketBinding;
    /** The upgrade did not happen. Releases everything the admission reserved. */
    failed(): void;
}

/** How a bridge ended: its recorded reason, and the WebSocket close it was given. */
export interface BridgeEnding {
    readonly reason: WorkspaceBridgeCloseReasonCode;
    readonly code: number;
    /** Human-readable, and short enough to be a WebSocket close reason. */
    readonly message: string;
}

/**
 * A change to this daemon lifetime's bridges.
 *
 * `ownerId` is who opened the bridge — a team user's ID, or `"standalone"` — and the only one who
 * may see the event.
 */
export type BridgeEvent =
    | {
          readonly type: "bridge.created";
          readonly ownerId: string;
          readonly payload: WorkspaceBridgeCreatedPayload;
      }
    | {
          readonly type: "bridge.updated";
          readonly ownerId: string;
          readonly payload: WorkspaceBridgeUpdatedPayload;
      }
    | {
          readonly type: "bridges.capabilities.updated";
          readonly payload: WorkspaceBridgeCapabilitiesUpdatedPayload;
      };

export type BridgeEventListener = (event: BridgeEvent) => void;
export const bridgeEventListenerSchema = Type.Function([Type.Any()], Type.Any());
