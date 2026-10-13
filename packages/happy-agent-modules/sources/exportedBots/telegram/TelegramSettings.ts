import { Type, type Static } from "@sinclair/typebox";

export const TELEGRAM_KIND = "telegram";

/**
 * A token from @BotFather: the bot's numeric ID, a colon, and its secret. The shape also makes
 * the token safe to place in a Bot API request path.
 */
export const telegramBotTokenSchema = Type.String({
    pattern: "^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$",
});

/** A Telegram export's stored settings. The token is read only to talk to Telegram. */
export const telegramSettingsSchema = Type.Object(
    { token: telegramBotTokenSchema },
    { additionalProperties: false },
);
export type TelegramSettings = Static<typeof telegramSettingsSchema>;

/** A numeric Telegram user ID in its decimal form. Telegram documents at most 52 bits. */
export const telegramUserIdPattern = /^[1-9][0-9]{0,15}$/;

/** A Telegram bot's numeric ID: the part of its token before the colon. */
export function telegramAccountOf(token: string): string {
    return token.slice(0, token.indexOf(":"));
}
