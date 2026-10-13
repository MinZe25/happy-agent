import { Type } from "@sinclair/typebox";

/** The Bot API server every Telegram export talks to unless `[telegram] api_url` names another. */
export const DEFAULT_TELEGRAM_API_URL = "https://api.telegram.org";

/** A Bot API server root, for a self-hosted `telegram-bot-api` server. */
export const telegramApiUrlSchema = Type.String({
    minLength: 8,
    maxLength: 2_048,
    pattern: "^https?://[^\\s/?#]+(/[^\\s?#]*)?$",
});
