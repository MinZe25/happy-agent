/** What the supervisor's `--connect` mode sends once it is connected. */
export const READY = Buffer.from("happy-agent-connect/1");

/** A connect frame header: one type byte and a big-endian payload length. */
export function header(type: string, length: number): Buffer {
    const bytes = Buffer.alloc(5);
    bytes[0] = type.charCodeAt(0);
    bytes.writeUInt32BE(length, 1);
    return bytes;
}

export function frame(type: string, payload = Buffer.alloc(0)): Buffer {
    return Buffer.concat([header(type, payload.byteLength), payload]);
}

/** `payload` as Docker's non-TTY attach delivers it on `stream`: 1 is output, 2 is error. */
export function stdcopy(stream: number, payload: Buffer): Buffer {
    const bytes = Buffer.alloc(8);
    bytes[0] = stream;
    bytes.writeUInt32BE(payload.byteLength, 4);
    return Buffer.concat([bytes, payload]);
}
