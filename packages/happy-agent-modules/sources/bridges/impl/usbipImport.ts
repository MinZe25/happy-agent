/**
 * The one USB/IP exchange a bridge speaks itself: importing a device by its bus ID.
 *
 * Everything after the import — the URB traffic between the kernel and the exporter — is relayed
 * byte for byte and never parsed here. All fields are big-endian, as USB/IP defines them.
 */

const USBIP_VERSION = 0x0111;
const OP_REQ_IMPORT = 0x8003;
const OP_REP_IMPORT = 0x0003;
const BUS_ID_BYTES = 32;
const HEADER_BYTES = 8;
/** `struct usbip_usb_device`: path, bus ID, three numbers, three identifiers, six class bytes. */
const DEVICE_BYTES = 312;

/** The longest a complete, successful import reply can be. */
export const USBIP_IMPORT_REPLY_BYTES = HEADER_BYTES + DEVICE_BYTES;

/** The device an exporter offered, as the kernel needs it and as a bridge describes it. */
export interface ImportedUsbDevice {
    readonly busId: string;
    /** `busnum << 16 | devnum`, the kernel's name for the remote device. */
    readonly devid: number;
    /** The kernel's `usb_device_speed`, 1 (low) through 6 (super plus). */
    readonly speed: number;
    readonly vendorId: number;
    readonly productId: number;
    readonly deviceClass: number;
    readonly deviceSubclass: number;
    readonly deviceProtocol: number;
}

export type UsbImportReply =
    /** More bytes are needed before the reply means anything. */
    | { readonly kind: "incomplete" }
    | { readonly kind: "malformed"; readonly message: string }
    /** The exporter answered with a non-zero status. */
    | { readonly kind: "refused"; readonly status: number }
    /** `length` is how many bytes the reply took; anything after it is not part of the import. */
    | { readonly kind: "device"; readonly device: ImportedUsbDevice; readonly length: number };

/** `OP_REQ_IMPORT` for one bus ID, which must be at most 31 ASCII characters. */
export function encodeUsbImportRequest(busId: string): Buffer {
    const request = Buffer.alloc(HEADER_BYTES + BUS_ID_BYTES);
    request.writeUInt16BE(USBIP_VERSION, 0);
    request.writeUInt16BE(OP_REQ_IMPORT, 2);
    request.writeUInt32BE(0, 4);
    // The remaining bytes stay zero, so the bus ID is NUL-terminated.
    request.write(busId, HEADER_BYTES, BUS_ID_BYTES - 1, "latin1");
    return request;
}

/** Reads `OP_REP_IMPORT` from the bytes received so far. */
export function parseUsbImportReply(bytes: Buffer): UsbImportReply {
    if (bytes.length < HEADER_BYTES) return { kind: "incomplete" };
    const version = bytes.readUInt16BE(0);
    const code = bytes.readUInt16BE(2);
    if (version !== USBIP_VERSION || code !== OP_REP_IMPORT) {
        return { kind: "malformed", message: "The USB/IP exporter did not answer the import." };
    }
    const status = bytes.readUInt32BE(4);
    // A refusing exporter sends the header alone.
    if (status !== 0) return { kind: "refused", status };
    if (bytes.length < USBIP_IMPORT_REPLY_BYTES) return { kind: "incomplete" };
    const device = bytes.subarray(HEADER_BYTES, USBIP_IMPORT_REPLY_BYTES);
    const busIdBytes = device.subarray(256, 256 + BUS_ID_BYTES);
    const end = busIdBytes.indexOf(0);
    if (end <= 0) {
        return { kind: "malformed", message: "The USB/IP exporter sent an invalid bus ID." };
    }
    const busnum = device.readUInt32BE(288);
    const devnum = device.readUInt32BE(292);
    const speed = device.readUInt32BE(296);
    if (busnum > 0xffff || devnum > 0xffff) {
        return { kind: "malformed", message: "The USB/IP exporter sent an invalid device number." };
    }
    if (speed < 1 || speed > 6) {
        return { kind: "malformed", message: "The USB/IP exporter sent an unknown device speed." };
    }
    return {
        kind: "device",
        length: USBIP_IMPORT_REPLY_BYTES,
        device: {
            busId: busIdBytes.subarray(0, end).toString("latin1"),
            devid: ((busnum << 16) | devnum) >>> 0,
            speed,
            vendorId: device.readUInt16BE(300),
            productId: device.readUInt16BE(302),
            deviceClass: device.readUInt8(306),
            deviceSubclass: device.readUInt8(307),
            deviceProtocol: device.readUInt8(308),
        },
    };
}
