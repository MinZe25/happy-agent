/** Telegram refuses a message longer than 4096 characters; stay clear of the limit. */
const MAX_TELEGRAM_MESSAGE_CHARACTERS = 4_000;

/**
 * Split a reply into Telegram-sized messages, preferring paragraph, then line, then word
 * boundaries, and never cutting a surrogate pair in half.
 */
export function splitTelegramText(text: string): string[] {
    const chunks: string[] = [];
    let rest = text.trim();
    while (rest.length > MAX_TELEGRAM_MESSAGE_CHARACTERS) {
        const window = rest.slice(0, MAX_TELEGRAM_MESSAGE_CHARACTERS);
        let cut = Math.max(window.lastIndexOf("\n\n"), 0);
        if (cut < MAX_TELEGRAM_MESSAGE_CHARACTERS / 2) cut = window.lastIndexOf("\n");
        if (cut < MAX_TELEGRAM_MESSAGE_CHARACTERS / 2) cut = window.lastIndexOf(" ");
        if (cut < MAX_TELEGRAM_MESSAGE_CHARACTERS / 2) cut = MAX_TELEGRAM_MESSAGE_CHARACTERS;
        const code = rest.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
        const chunk = rest.slice(0, cut).trimEnd();
        if (chunk.length > 0) chunks.push(chunk);
        rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks;
}
