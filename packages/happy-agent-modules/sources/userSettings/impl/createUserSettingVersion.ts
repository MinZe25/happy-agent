import { randomBytes } from "node:crypto";

const RANDOM_MASK = (1n << 74n) - 1n;
const RAND_B_MASK = (1n << 62n) - 1n;
const MAX_TIMESTAMP = (1n << 48n) - 1n;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Mint one person's next UUIDv7, strictly greater than the last one minted for them. That mark is
 * persisted, so versions keep increasing across restarts and a wall clock moved backwards.
 */
export function createUserSettingVersion(previous: string | undefined, now: number): string {
    const prior = previous === undefined ? undefined : parseVersion(previous);
    let timestamp = BigInt(Math.max(0, Math.trunc(now)));
    let randomTail: bigint;
    if (prior !== undefined && timestamp <= prior.timestamp) {
        timestamp = prior.timestamp;
        randomTail = (prior.randomTail + 1n) & RANDOM_MASK;
        if (randomTail === 0n) timestamp += 1n;
    } else {
        randomTail = 0n;
        for (const byte of randomBytes(10)) randomTail = (randomTail << 8n) | BigInt(byte);
        randomTail &= RANDOM_MASK;
    }
    if (timestamp > MAX_TIMESTAMP) {
        throw new Error("The system clock is outside the UUIDv7 timestamp range.");
    }
    const value =
        (timestamp << 80n) |
        (7n << 76n) |
        ((randomTail >> 62n) << 64n) |
        (2n << 62n) |
        (randomTail & RAND_B_MASK);
    const hex = value.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseVersion(value: string): { readonly randomTail: bigint; readonly timestamp: bigint } {
    if (!UUID_V7_PATTERN.test(value)) throw new Error("A stored user setting version is invalid.");
    const parsed = BigInt(`0x${value.replaceAll("-", "")}`);
    return {
        randomTail: (((parsed >> 64n) & 0xfffn) << 62n) | (parsed & RAND_B_MASK),
        timestamp: parsed >> 80n,
    };
}
