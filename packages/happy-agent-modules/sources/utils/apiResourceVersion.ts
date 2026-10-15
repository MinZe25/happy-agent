import { createHash } from "node:crypto";

/** Deterministic, time-ordered UUIDv7 projection of a module's numeric resource version. */
export function apiResourceVersion(updatedAt: number, version: number, resourceId: string): string {
    const timestamp = BigInt(Math.max(0, Math.trunc(updatedAt))) & 0xffffffffffffn;
    const numericVersion = BigInt(Math.max(0, Math.trunc(version))) & ((1n << 53n) - 1n);
    const hash = createHash("sha256").update(resourceId).digest();
    const hashTail = BigInt(hash.readUInt32BE(0) & 0x1fffff);
    const random = (numericVersion << 21n) | hashTail;
    const highRandom = Number((random >> 62n) & 0xfffn);
    const middleRandom = Number((random >> 48n) & 0x3fffn);
    const lowRandom = random & 0xffffffffffffn;
    const timestampHex = timestamp.toString(16).padStart(12, "0");
    return [
        timestampHex.slice(0, 8),
        timestampHex.slice(8),
        `7${highRandom.toString(16).padStart(3, "0")}`,
        (0x8000 | middleRandom).toString(16).padStart(4, "0"),
        lowRandom.toString(16).padStart(12, "0"),
    ].join("-");
}
