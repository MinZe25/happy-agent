import { describe, expect, it } from "vitest";

import {
    callsEmojiChecksum,
    callsEmojiForRawKey,
} from "../../../sources/mobileConnector/impl/callsEmoji.js";
import {
    createDaemonPairingKey,
    derivePairingSecrets,
    deviceTokenHash,
    pairingCommitment,
    pairingMac,
    pairingSharedSecret,
    pairingTranscriptHash,
} from "../../../sources/mobileConnector/impl/mobilePairingCrypto.js";

const filled = (value: number) => Buffer.alloc(32, value);

describe("daemon pairing crypto", () => {
    it("carries Telegram's exact emoji table", () => {
        expect(callsEmojiChecksum()).toBe(
            "c22c3a00d5a68df075fecc8cb8b730a45817a246a5ca70fa3b75d248ac5b54e9",
        );
        // Telegram's third published vector: the emoji for the raw key 00…1f.
        expect(callsEmojiForRawKey(Uint8Array.from({ length: 32 }, (_, index) => index))).toEqual([
            "🙉",
            "🇷🇺",
            "☔️",
            "✈️",
        ]);
    });

    it("reproduces the vectors computed independently with Python's cryptography package", () => {
        const phone = createDaemonPairingKey(filled(1));
        const daemon = createDaemonPairingKey(filled(2));
        expect(phone.publicKey.toString("hex")).toBe(
            "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209",
        );
        expect(daemon.publicKey.toString("hex")).toBe(
            "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59",
        );
        const commitment = pairingCommitment(phone.publicKey, filled(4));
        expect(commitment.toString("hex")).toBe(
            "ae75325169fe3b8d8571df1c5fd015ef9989051a0363e780322a09ebf2430caf",
        );
        const shared = pairingSharedSecret(daemon.privateKey, phone.publicKey);
        expect(shared.toString("hex")).toBe(
            "2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953",
        );
        const transcriptHash = pairingTranscriptHash({
            token: filled(3),
            commitment,
            phonePublicKey: phone.publicKey,
            daemonPublicKey: daemon.publicKey,
            phoneNonce: filled(4),
            daemonNonce: filled(5),
            address: "tcFixedVectorAddress",
            port: 24_781,
        });
        expect(transcriptHash.toString("hex")).toBe(
            "919140a78d542ec0999e8b045e9b368c94a5cc2d90d6c92e7f14e8d6d302eb08",
        );
        const secrets = derivePairingSecrets(shared, transcriptHash);
        expect(secrets.confirmKey.toString("hex")).toBe(
            "152eb695974a86f350d777dd1a7e63abb327eb6af37ee465addbb46ea53cde3f",
        );
        expect(secrets.emoji).toEqual(["🌀", "👗", "⏳", "👟"]);
        expect(pairingMac(secrets.confirmKey, transcriptHash, "mobile").toString("hex")).toBe(
            "56562cd319819213d10c33fd9e508fffb19343d84b14882ecfc550c058181d85",
        );
        expect(pairingMac(secrets.confirmKey, transcriptHash, "daemon").toString("hex")).toBe(
            "81fa0f2f506f539f4ca3f22eeeac675850f3cd902719f14799fc6519266893c9",
        );
        expect(deviceTokenHash(secrets.deviceToken)).toBe(
            "dd652c0915a809fbbdbedc963a8ddf0c940cff4bda204d9b9d886b3e661f67b1",
        );
    });

    it("refuses low-order phone keys", () => {
        const daemon = createDaemonPairingKey();
        for (const hex of [
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0100000000000000000000000000000000000000000000000000000000000000",
            "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
            "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        ]) {
            expect(() => pairingSharedSecret(daemon.privateKey, Buffer.from(hex, "hex"))).toThrow(
                "The phone's public key is not usable for pairing.",
            );
        }
    });
});
