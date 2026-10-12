/** An `OP_REP_IMPORT` as an exporter would send it, for one Arduino-like device. */
export function usbImportReply(options: {
    readonly busId: string;
    readonly status?: number;
    readonly busnum?: number;
    readonly devnum?: number;
    readonly speed?: number;
}): Buffer {
    const reply = Buffer.alloc(8 + 312);
    reply.writeUInt16BE(0x0111, 0);
    reply.writeUInt16BE(0x0003, 2);
    reply.writeUInt32BE(options.status ?? 0, 4);
    const device = reply.subarray(8);
    device.write("/sys/devices/pci0000:00/usb1/1-2", 0, "latin1");
    device.write(options.busId, 256, 31, "latin1");
    device.writeUInt32BE(options.busnum ?? 1, 288);
    device.writeUInt32BE(options.devnum ?? 4, 292);
    device.writeUInt32BE(options.speed ?? 2, 296);
    device.writeUInt16BE(0x2341, 300);
    device.writeUInt16BE(0x0043, 302);
    device.writeUInt16BE(0x0001, 304);
    device.writeUInt8(2, 306);
    device.writeUInt8(0, 307);
    device.writeUInt8(0, 308);
    device.writeUInt8(1, 309);
    device.writeUInt8(1, 310);
    device.writeUInt8(2, 311);
    return reply;
}
