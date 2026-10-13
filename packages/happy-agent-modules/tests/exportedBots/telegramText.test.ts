import { describe, expect, it } from "vitest";

import { senderDisplayName } from "../../sources/exportedBots/impl/senderDisplayName.js";
import { exportedBotMessageId } from "../../sources/exportedBots/impl/exportedBotMessageId.js";
import { splitTelegramText } from "../../sources/exportedBots/telegram/splitTelegramText.js";
import { telegramMessageText } from "../../sources/exportedBots/telegram/telegramMessageText.js";

describe("splitting a reply into Telegram messages", () => {
    it("keeps a short reply whole", () => {
        expect(splitTelegramText("  Hello there.  ")).toEqual(["Hello there."]);
    });

    it("splits at paragraph boundaries and keeps every message under Telegram's limit", () => {
        const paragraph = "word ".repeat(300).trim();
        const text = Array.from({ length: 8 }, () => paragraph).join("\n\n");
        const chunks = splitTelegramText(text);

        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4_000);
        expect(chunks.join("\n\n")).toBe(text);
    });

    it("cuts unbroken text without splitting a surrogate pair", () => {
        const text = `${"a".repeat(3_999)}😀${"b".repeat(10)}`;
        const chunks = splitTelegramText(text);

        expect(chunks).toEqual(["a".repeat(3_999), `😀${"b".repeat(10)}`]);
    });
});

describe("what the agent is shown for a Telegram message", () => {
    const base = { message_id: 1, date: 1, chat: { id: 5, type: "private" } };

    it("uses the text or caption and names content it cannot open", () => {
        expect(telegramMessageText({ ...base, text: " hi " }, undefined)).toBe("hi");
        expect(telegramMessageText({ ...base, caption: "look", photo: [] }, undefined)).toBe(
            "look\n\n(They sent a photo, which this bot cannot open on Telegram.)",
        );
        expect(telegramMessageText({ ...base, voice: {} } as never, undefined)).toBe(
            "(They sent a voice message, which this bot cannot open on Telegram.)",
        );
        expect(telegramMessageText(base, undefined)).toBe("");
    });

    it("needs no note for a photo that arrives as an attachment", () => {
        expect(telegramMessageText({ ...base, caption: "look", photo: [] }, "attached")).toBe(
            "look",
        );
        expect(telegramMessageText({ ...base, photo: [] }, "not_fetched")).toBe(
            "(They sent a photo that could not be fetched, which this bot cannot open on Telegram.)",
        );
    });
});

describe("naming a person writing to an exported bot", () => {
    it("uses their name, then username, then ID, without control characters", () => {
        const name = (input: { name?: string; username?: string; userId: string }) =>
            senderDisplayName({
                name: input.name,
                username: input.username,
                userId: input.userId,
                service: "Telegram",
            });
        expect(name({ name: "Ada\n Lovelace", userId: "1" })).toBe("Ada Lovelace");
        expect(name({ name: " ", username: "ada", userId: "1" })).toBe("@ada");
        expect(name({ userId: "7" })).toBe("Telegram user 7");
    });
});

describe("exported bot message identities", () => {
    it("derives one stable agent message ID per message, kind, and account", () => {
        const id = exportedBotMessageId("telegram", "123", "10:5:1");

        expect(id).toMatch(/^[a-z][a-z0-9]{1,31}$/);
        expect(exportedBotMessageId("telegram", "123", "10:5:1")).toBe(id);
        expect(exportedBotMessageId("telegram", "123", "11:5:1")).not.toBe(id);
        expect(exportedBotMessageId("telegram", "456", "10:5:1")).not.toBe(id);
        expect(exportedBotMessageId("bridge", "123", "10:5:1")).not.toBe(id);
    });
});
