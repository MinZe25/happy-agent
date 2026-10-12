import type { Socket } from "node:net";

import {
    WORKSPACE_BRIDGE_CLOSE_CODES,
    type WorkspaceUsbBridgeDevice,
    type WorkspaceUsbSpeed,
} from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import {
    USB_IMPORT_TIMEOUT_MS,
    type BridgeEnding,
    type BridgeWebSocket,
    type BridgeWebSocketBinding,
} from "../Bridge.js";
import { UsbAttachError } from "./attachVhciDevice.js";
import { relayBridgeSocket, type BridgeRelay } from "./relayBridgeSocket.js";
import type { UsbHostController } from "./UsbHostController.js";
import {
    encodeUsbImportRequest,
    parseUsbImportReply,
    type ImportedUsbDevice,
} from "./usbipImport.js";

const SPEEDS: Record<number, WorkspaceUsbSpeed> = {
    1: "low",
    2: "full",
    3: "high",
    4: "wireless",
    5: "super",
    6: "super_plus",
};

export interface UsbBridgeSessionOptions {
    readonly busId: string;
    readonly controller: UsbHostController;
    /** The bridge's own lifetime, for logging and for the kernel attachment. */
    readonly ctx: Context;
    /** The kernel took the device; the bridge exists from here. */
    readonly opened: (device: WorkspaceUsbBridgeDevice) => void;
    /** The bridge ended, whether or not it ever opened. Called once. */
    readonly ended: (ending: BridgeEnding) => void;
}

/**
 * One USB device on its way into, and then inside, the workspace machine's kernel.
 *
 * The client's exporter is a USB/IP server for exactly one device, and this session is its
 * client: it imports the device over the WebSocket, hands the kernel one end of a socket pair
 * carrying the rest of the connection, and relays that connection's bytes until either side ends.
 */
export class UsbBridgeSession {
    readonly #options: UsbBridgeSessionOptions;
    #state: "admitted" | "importing" | "attaching" | "open" | "ended" = "admitted";
    #ending: BridgeEnding | undefined;
    #webSocket: BridgeWebSocket | undefined;
    #reply: Buffer = Buffer.alloc(0);
    #deadline: ReturnType<typeof setTimeout> | undefined;
    #kernel: Socket | undefined;
    #relay: BridgeRelay | undefined;

    constructor(options: UsbBridgeSessionOptions) {
        this.#options = options;
    }

    /** How the bridge ended, once it has. */
    get ending(): BridgeEnding | undefined {
        return this.#ending;
    }

    attach(webSocket: BridgeWebSocket): BridgeWebSocketBinding {
        if (this.#state !== "admitted") {
            const ending = this.#ending ?? INTERNAL;
            webSocket.close(ending.code, ending.message);
            return { message: () => undefined, closed: () => undefined };
        }
        this.#webSocket = webSocket;
        this.#state = "importing";
        this.#deadline = setTimeout(() => {
            this.end({
                reason: "failed",
                code: WORKSPACE_BRIDGE_CLOSE_CODES.importTimeout,
                message: "The USB device did not answer the import in time.",
            });
        }, USB_IMPORT_TIMEOUT_MS);
        this.#deadline.unref?.();
        webSocket.send(encodeUsbImportRequest(this.#options.busId));
        return {
            message: (data) => {
                this.#message(data);
            },
            closed: () => {
                this.end(CLIENT_CLOSED);
            },
        };
    }

    /** Ends the bridge: closes its WebSocket and the kernel's connection, which detaches it. */
    end(ending: BridgeEnding): void {
        if (this.#state === "ended") return;
        this.#state = "ended";
        this.#ending = ending;
        if (this.#deadline !== undefined) clearTimeout(this.#deadline);
        this.#relay?.stop();
        this.#kernel?.destroy();
        this.#webSocket?.close(ending.code, ending.message);
        this.#options.ended(ending);
    }

    #message(data: Uint8Array | string): void {
        if (this.#state === "ended") return;
        if (typeof data === "string") {
            this.end(protocolViolation("USB bridge messages must be binary."));
            return;
        }
        if (this.#state === "open") {
            this.#relay?.write(data);
            return;
        }
        if (this.#state !== "importing") {
            // The exporter speaks only when the kernel asks, and the kernel has not asked yet.
            this.end(protocolViolation("The USB/IP exporter sent data before the kernel asked."));
            return;
        }
        this.#reply = Buffer.concat([this.#reply, data]);
        // A reply is whole or wrong within its first few hundred bytes, so this buffer never holds
        // more than one message beyond them.
        const reply = parseUsbImportReply(this.#reply);
        if (reply.kind === "incomplete") return;
        if (reply.kind === "malformed") {
            this.end(protocolViolation(reply.message));
            return;
        }
        if (reply.kind === "refused") {
            this.end({
                reason: "failed",
                code: WORKSPACE_BRIDGE_CLOSE_CODES.deviceRefused,
                message: "The USB/IP exporter refused to export the device.",
            });
            return;
        }
        if (this.#reply.length > reply.length) {
            this.end(protocolViolation("The USB/IP exporter sent data before the kernel asked."));
            return;
        }
        if (reply.device.busId !== this.#options.busId) {
            this.end({
                reason: "failed",
                code: WORKSPACE_BRIDGE_CLOSE_CODES.deviceRefused,
                message: "The USB/IP exporter offered a different device.",
            });
            return;
        }
        this.#reply = Buffer.alloc(0);
        void this.#attachKernel(reply.device);
    }

    async #attachKernel(device: ImportedUsbDevice): Promise<void> {
        if (this.#deadline !== undefined) clearTimeout(this.#deadline);
        this.#state = "attaching";
        let attached;
        try {
            attached = await this.#options.controller.attach(this.#options.ctx, device);
        } catch (error) {
            if (error instanceof UsbAttachError && error.reason === "no_free_port") {
                this.end({
                    reason: "failed",
                    code: WORKSPACE_BRIDGE_CLOSE_CODES.noFreePort,
                    message:
                        "No USB port of the device's speed is free on the workspace's machine.",
                });
                return;
            }
            this.#options.ctx.log.warn("The kernel refused a USB bridge's device.", {}, error);
            this.end({
                reason: "failed",
                code: WORKSPACE_BRIDGE_CLOSE_CODES.kernelRefused,
                message: "The workspace's kernel refused the USB device.",
            });
            return;
        }
        if (this.#ending !== undefined) {
            // The client left while the kernel was attaching. Closing our end detaches it again.
            attached.socket.destroy();
            return;
        }
        this.#kernel = attached.socket;
        this.#state = "open";
        this.#options.opened({
            busId: device.busId,
            vendorId: hex(device.vendorId),
            productId: hex(device.productId),
            deviceClass: device.deviceClass,
            deviceSubclass: device.deviceSubclass,
            deviceProtocol: device.deviceProtocol,
            speed: SPEEDS[device.speed] ?? "full",
            port: attached.port,
        });
        // Announcing the bridge may have ended it, if nobody wants it any more.
        if (this.#ending !== undefined || this.#webSocket === undefined) return;
        this.#relay = relayBridgeSocket(attached.socket, this.#webSocket, (cause) => {
            this.end(
                cause === "overflow"
                    ? {
                          reason: "failed",
                          code: WORKSPACE_BRIDGE_CLOSE_CODES.internal,
                          message: "The workspace's kernel is not keeping up with the device.",
                      }
                    : {
                          reason: "device_detached",
                          code: WORKSPACE_BRIDGE_CLOSE_CODES.normal,
                          message: "The USB device was detached from the workspace's machine.",
                      },
            );
        });
    }
}

const CLIENT_CLOSED: BridgeEnding = {
    reason: "client_closed",
    code: WORKSPACE_BRIDGE_CLOSE_CODES.normal,
    message: "The client closed the bridge.",
};

const INTERNAL: BridgeEnding = {
    reason: "failed",
    code: WORKSPACE_BRIDGE_CLOSE_CODES.internal,
    message: "The bridge could not be opened.",
};

function protocolViolation(message: string): BridgeEnding {
    return { reason: "failed", code: WORKSPACE_BRIDGE_CLOSE_CODES.protocolViolation, message };
}

function hex(value: number): string {
    return value.toString(16).padStart(4, "0");
}
