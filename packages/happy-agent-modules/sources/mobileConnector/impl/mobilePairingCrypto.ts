import {
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    timingSafeEqual,
    type KeyObject,
} from "node:crypto";

import { callsEmojiForRawKey } from "./callsEmoji.js";

/**
 * The daemon's half of mobile pairing v1, as `API_MOBILE.md` specifies it, on Node's crypto:
 *
 * ```text
 * C   = SHA256("happy-mobile-pair-v1/commit" ‖ A ‖ Nm)
 * TH  = SHA256("happy-mobile-pair-v1" ‖ lp(t) ‖ lp(C) ‖ lp(A) ‖ lp(B) ‖ lp(Nm) ‖ lp(Nd)
 *              ‖ lp(utf8(address)) ‖ lp(u16be(port)))
 * PRK = HKDF-Extract(salt = TH, ikm = X25519(b, A))
 * emojiKey, confirmKey, deviceToken = HKDF-Expand(PRK, "happy-mobile-pair-v1 <purpose>", 32)
 * MAC(role) = HMAC-SHA256(confirmKey, role ‖ TH)
 * ```
 *
 * `lp(x)` is a 4-byte big-endian length then `x`, and `t` is the token's 32 bytes.
 */
const LABEL = "happy-mobile-pair-v1";
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export interface DaemonPairingKey {
    readonly privateKey: KeyObject;
    readonly publicKey: Buffer;
}

export interface PairingTranscript {
    readonly token: Buffer;
    readonly commitment: Buffer;
    readonly phonePublicKey: Buffer;
    readonly daemonPublicKey: Buffer;
    readonly phoneNonce: Buffer;
    readonly daemonNonce: Buffer;
    readonly address: string;
    readonly port: number;
}

export interface PairingSecrets {
    readonly transcriptHash: Buffer;
    readonly confirmKey: Buffer;
    readonly deviceToken: Buffer;
    readonly emoji: readonly string[];
}

/** A fresh X25519 key, or the one with this private scalar for fixed test vectors. */
export function createDaemonPairingKey(privateScalar?: Buffer): DaemonPairingKey {
    const privateKey =
        privateScalar === undefined
            ? generateKeyPairSync("x25519").privateKey
            : createPrivateKey({
                  key: Buffer.concat([PKCS8_X25519_PREFIX, exact(privateScalar, "private key")]),
                  format: "der",
                  type: "pkcs8",
              });
    const jwk = createPublicKey(privateKey).export({ format: "jwk" });
    if (typeof jwk.x !== "string") throw new Error("Node returned no X25519 public key.");
    return { privateKey, publicKey: exact(Buffer.from(jwk.x, "base64url"), "public key") };
}

export function pairingCommitment(phonePublicKey: Buffer, phoneNonce: Buffer): Buffer {
    return createHash("sha256")
        .update(`${LABEL}/commit`, "utf8")
        .update(exact(phonePublicKey, "public key"))
        .update(exact(phoneNonce, "nonce"))
        .digest();
}

/**
 * The shared secret, refusing every low-order key. Clamping makes each of them produce zero,
 * which OpenSSL refuses outright; the explicit check keeps that guarantee on any build.
 */
export function pairingSharedSecret(own: KeyObject, phonePublicKey: Buffer): Buffer {
    let shared: Buffer;
    try {
        const publicKey = createPublicKey({
            key: {
                kty: "OKP",
                crv: "X25519",
                x: exact(phonePublicKey, "public key").toString("base64url"),
            },
            format: "jwk",
        });
        shared = diffieHellman({ privateKey: own, publicKey });
    } catch {
        throw new Error("The phone's public key is not usable for pairing.");
    }
    if (shared.length !== 32 || shared.every((byte) => byte === 0)) {
        throw new Error("The phone's public key is not usable for pairing.");
    }
    return shared;
}

export function pairingTranscriptHash(transcript: PairingTranscript): Buffer {
    const port = Buffer.alloc(2);
    port.writeUInt16BE(transcript.port);
    const hash = createHash("sha256").update(LABEL, "utf8");
    for (const part of [
        exact(transcript.token, "token"),
        exact(transcript.commitment, "commitment"),
        exact(transcript.phonePublicKey, "public key"),
        exact(transcript.daemonPublicKey, "public key"),
        exact(transcript.phoneNonce, "nonce"),
        exact(transcript.daemonNonce, "nonce"),
        Buffer.from(transcript.address, "utf8"),
        port,
    ]) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(part.length);
        hash.update(length).update(part);
    }
    return hash.digest();
}

export function derivePairingSecrets(shared: Buffer, transcriptHash: Buffer): PairingSecrets {
    const expand = (purpose: string) =>
        Buffer.from(hkdfSync("sha256", shared, transcriptHash, `${LABEL} ${purpose}`, 32));
    return {
        transcriptHash,
        confirmKey: expand("confirm"),
        deviceToken: expand("device-token"),
        emoji: callsEmojiForRawKey(expand("emoji")),
    };
}

export function pairingMac(
    confirmKey: Buffer,
    transcriptHash: Buffer,
    role: "mobile" | "daemon",
): Buffer {
    return createHmac("sha256", confirmKey).update(role, "utf8").update(transcriptHash).digest();
}

/** The only form of a device token the daemon keeps: its SHA-256 as lowercase hex. */
export function deviceTokenHash(deviceToken: Buffer): string {
    return createHash("sha256").update(exact(deviceToken, "device token")).digest("hex");
}

export function bytesEqual(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && timingSafeEqual(left, right);
}

function exact(value: Buffer, name: string): Buffer {
    if (value.length !== 32) throw new Error(`The pairing ${name} must be 32 bytes.`);
    return value;
}
