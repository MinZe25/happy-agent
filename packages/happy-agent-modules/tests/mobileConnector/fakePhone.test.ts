import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { callsEmojiChecksum } from "../../sources/mobileConnector/impl/callsEmoji.js";
import {
    commitment,
    derive,
    mac,
    phoneKey,
    specEmoji,
    specEmojiTable,
} from "./support/fakePhone.js";

const filled = (value: number) => Buffer.alloc(32, value);

/**
 * The test phone is a second implementation of API_MOBILE.md. Pinning it to the specification's
 * table and vectors is what makes its agreement with the daemon a real cross-check.
 */
describe("the test phone follows API_MOBILE.md", () => {
    it("reads the exact Telegram table from the specification", () => {
        const table = specEmojiTable();
        expect(table).toHaveLength(333);
        expect(createHash("sha256").update(table.join("\n"), "utf8").digest("hex")).toBe(
            "c22c3a00d5a68df075fecc8cb8b730a45817a246a5ca70fa3b75d248ac5b54e9",
        );
        expect(callsEmojiChecksum()).toBe(
            "c22c3a00d5a68df075fecc8cb8b730a45817a246a5ca70fa3b75d248ac5b54e9",
        );
        const counting = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
        expect(specEmoji(Buffer.alloc(32))).toEqual(["😉", "😉", "😉", "😉"]);
        expect(specEmoji(counting)).toEqual(["💍", "☔️", "📅", "🍞"]);
        expect(specEmoji(createHash("sha256").update(counting).digest())).toEqual([
            "🙉",
            "🇷🇺",
            "☔️",
            "✈️",
        ]);
    });

    it("reproduces the specification's fixed vectors", () => {
        const own = phoneKey(filled(1));
        const daemon = phoneKey(filled(2));
        expect(own.publicKey.toString("hex")).toBe(
            "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209",
        );
        const committed = commitment(own.publicKey, filled(4));
        expect(committed.toString("hex")).toBe(
            "ae75325169fe3b8d8571df1c5fd015ef9989051a0363e780322a09ebf2430caf",
        );
        const secrets = derive({
            own,
            daemonPublicKey: daemon.publicKey,
            token: filled(3),
            commitment: committed,
            phoneNonce: filled(4),
            daemonNonce: filled(5),
            address: "tcFixedVectorAddress",
            port: 24_781,
        });
        expect(secrets.sharedSecret.toString("hex")).toBe(
            "2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953",
        );
        expect(secrets.transcriptHash.toString("hex")).toBe(
            "919140a78d542ec0999e8b045e9b368c94a5cc2d90d6c92e7f14e8d6d302eb08",
        );
        expect(secrets.emojiKey.toString("hex")).toBe(
            "fa42488ee1ceadb6998e8d35792cdda1a1210a63153069fe67f1f1ce57404369",
        );
        expect(secrets.deviceToken.toString("hex")).toBe(
            "05bf38156a0b81046b4e15f584760e0e8996efe81239e5efe4560fef29c20aeb",
        );
        expect(mac(secrets, "mobile").toString("hex")).toBe(
            "56562cd319819213d10c33fd9e508fffb19343d84b14882ecfc550c058181d85",
        );
        expect(mac(secrets, "daemon").toString("hex")).toBe(
            "81fa0f2f506f539f4ca3f22eeeac675850f3cd902719f14799fc6519266893c9",
        );
        expect(secrets.emoji).toEqual(["🌀", "👗", "⏳", "👟"]);
    });
});
