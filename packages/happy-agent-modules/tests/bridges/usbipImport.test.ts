import { describe, expect, it } from "vitest";

import {
    encodeUsbImportRequest,
    parseUsbImportReply,
    USBIP_IMPORT_REPLY_BYTES,
} from "../../sources/bridges/impl/usbipImport.js";
import { usbImportReply } from "./support/usbip.js";

describe("USB/IP import", () => {
    it("asks for a bus ID with version 0x0111 and a NUL-terminated, 32-byte field", () => {
        const request = encodeUsbImportRequest("1-2.3");

        expect(request.length).toBe(40);
        expect(request.subarray(0, 8)).toEqual(
            Buffer.from([0x01, 0x11, 0x80, 0x03, 0x00, 0x00, 0x00, 0x00]),
        );
        expect(request.subarray(8, 13).toString("latin1")).toBe("1-2.3");
        expect(request.subarray(13).every((byte) => byte === 0)).toBe(true);
    });

    it("reads the device an exporter offers, with its kernel device ID", () => {
        const reply = parseUsbImportReply(
            usbImportReply({ busId: "1-2", busnum: 3, devnum: 7, speed: 2 }),
        );

        expect(reply).toEqual({
            kind: "device",
            length: USBIP_IMPORT_REPLY_BYTES,
            device: {
                busId: "1-2",
                devid: (3 << 16) | 7,
                speed: 2,
                vendorId: 0x2341,
                productId: 0x0043,
                deviceClass: 2,
                deviceSubclass: 0,
                deviceProtocol: 0,
            },
        });
    });

    it("waits for a reply split across messages", () => {
        const whole = usbImportReply({ busId: "1-2" });

        expect(parseUsbImportReply(whole.subarray(0, 5))).toEqual({ kind: "incomplete" });
        expect(parseUsbImportReply(whole.subarray(0, 100))).toEqual({ kind: "incomplete" });
        expect(parseUsbImportReply(whole).kind).toBe("device");
    });

    it("takes a non-zero status from the header alone as a refusal", () => {
        const header = usbImportReply({ busId: "1-2", status: 1 }).subarray(0, 8);

        expect(parseUsbImportReply(header)).toEqual({ kind: "refused", status: 1 });
    });

    it("refuses a reply that is not an import reply, or that describes no real device", () => {
        const wrongCode = usbImportReply({ busId: "1-2" });
        wrongCode.writeUInt16BE(0x0005, 2);
        const noBusId = usbImportReply({ busId: "" });
        const unknownSpeed = usbImportReply({ busId: "1-2", speed: 9 });
        const hugeBus = usbImportReply({ busId: "1-2", busnum: 0x10000 });

        for (const bytes of [wrongCode, noBusId, unknownSpeed, hugeBus]) {
            expect(parseUsbImportReply(bytes).kind).toBe("malformed");
        }
    });
});
