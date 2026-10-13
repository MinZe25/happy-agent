import type { TelegramMessage } from "./TelegramBotApi.js";

/** Content an exported bot's conversation cannot read yet, named the way a person would describe it. */
const UNSUPPORTED_CONTENT: readonly (readonly [string, string])[] = [
    ["photo", "a photo"],
    ["video", "a video"],
    ["video_note", "a video message"],
    ["voice", "a voice message"],
    ["audio", "an audio file"],
    ["document", "a file"],
    ["sticker", "a sticker"],
    ["animation", "a GIF"],
    ["location", "a location"],
    ["contact", "a contact"],
    ["poll", "a poll"],
];

/**
 * What the agent is shown for one incoming message: its text or caption, plus a note for content
 * it cannot open, so it can tell the person rather than answer something they did not say. A
 * photo that was fetched arrives as an attachment and needs no note.
 */
export function telegramMessageText(
    message: TelegramMessage,
    photo: "attached" | "not_fetched" | undefined,
): string {
    const text = (message.text ?? message.caption ?? "").trim();
    const kind =
        photo === "attached"
            ? undefined
            : photo === "not_fetched"
              ? "a photo that could not be fetched"
              : UNSUPPORTED_CONTENT.find(([key]) => key in message)?.[1];
    if (kind === undefined) return text;
    const note = `(They sent ${kind}, which this bot cannot open on Telegram.)`;
    return text.length > 0 ? `${text}\n\n${note}` : note;
}
