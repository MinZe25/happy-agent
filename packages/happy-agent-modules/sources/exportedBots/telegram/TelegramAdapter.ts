import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { isAbortedError, type Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../../config/index.js";
import {
    ExportedBotError,
    type ExportedBotAdapter,
    type ExportedBotConnection,
    type ExportedBotEndpoint,
    type ExportedBotRecipient,
    type ExportedBotReply,
    type InboundEvent,
} from "../ExportedBotAdapter.js";
import type { ExportedBotsModule } from "../ExportedBotsModule.js";
import { setTelegramExportedBotTool } from "./set_telegram_exported_bot.js";
import { splitTelegramText } from "./splitTelegramText.js";
import {
    MAX_TELEGRAM_DOWNLOAD_BYTES,
    MAX_TELEGRAM_FILE_UPLOAD_BYTES,
    MAX_TELEGRAM_PHOTO_UPLOAD_BYTES,
    TelegramApiError,
    TelegramBotApi,
    telegramMessageSchema,
    type TelegramUpdate,
} from "./TelegramBotApi.js";
import { telegramMessageText } from "./telegramMessageText.js";
import {
    TELEGRAM_KIND,
    telegramSettingsSchema,
    type TelegramSettings,
} from "./TelegramSettings.js";

/** How long one `getUpdates` request waits for a message before asking again. */
const LONG_POLL_SECONDS = 50;
/** Telegram shows "typing…" for about five seconds, so it is renewed no more often than this. */
const TYPING_INTERVAL_MS = 4_000;
/** Pictures Telegram shows as photos; anything else is sent as a document. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Telegram, through the Bot API. An export long-polls `getUpdates` and keeps the next update ID
 * as its resume state, so a restart continues after the last update that reached a
 * conversation. Telegram's numeric IDs are handed on as decimal strings.
 */
export class TelegramAdapter implements ExportedBotAdapter<TelegramSettings> {
    readonly kind = TELEGRAM_KIND;
    readonly settingsSchema = telegramSettingsSchema;
    readonly formattingInstructions =
        "Telegram shows it as plain text: write short conversational paragraphs and avoid Markdown headings, bold or italic markers, tables, and code fences unless the content needs them.";
    readonly typing = {
        intervalMs: TYPING_INTERVAL_MS,
        show: async (
            ctx: Context,
            endpoint: ExportedBotEndpoint<TelegramSettings>,
            to: ExportedBotRecipient,
        ): Promise<void> => {
            await this.#api(endpoint.settings).sendTyping(ctx, telegramChatId(to.chatId));
        },
    };

    readonly #config: ConfigModule;

    constructor(config: ConfigModule) {
        this.#config = config;
    }

    names() {
        return { service: "Telegram", account: "Telegram bot" };
    }

    /** A Telegram user ID is the same person on every bot, so every bot shares their guest. */
    guestScope(): string {
        return "";
    }

    linkTo(username: string): string {
        return `t.me/${username}`;
    }

    /** Ask Telegram who a token belongs to. Refuses a token Telegram rejects outright. */
    async verify(ctx: Context, token: string): Promise<string | undefined> {
        try {
            const me = await new TelegramBotApi(token, this.#config.telegramApiUrl).getMe(ctx);
            return me.username;
        } catch (error: unknown) {
            if (error instanceof TelegramApiError && error.permanent) {
                throw new Error(error.message);
            }
            // Telegram may be briefly unreachable; the export keeps trying once saved.
            if (error instanceof TelegramApiError) return undefined;
            throw error;
        }
    }

    async run(ctx: Context, connection: ExportedBotConnection<TelegramSettings>): Promise<void> {
        const api = this.#api(connection.settings);
        connection.identify((await api.getMe(ctx)).username);
        while (ctx.lifetime?.aborted !== true) {
            const state = await connection.readState(ctx);
            const offset = state === undefined ? undefined : Number(state);
            const updates = await api.getUpdates(
                ctx,
                Number.isSafeInteger(offset) ? offset : undefined,
                LONG_POLL_SECONDS,
            );
            connection.connected();
            for (const update of updates) {
                await this.#take(ctx, api, connection, update);
            }
        }
    }

    /**
     * Hand one update to the export. A photo from someone the export admits is fetched into
     * the export's private folder first and removed once the message is taken in; nobody
     * else's files are fetched.
     */
    async #take(
        ctx: Context,
        api: TelegramBotApi,
        connection: ExportedBotConnection<TelegramSettings>,
        update: TelegramUpdate,
    ): Promise<void> {
        const state = String(update.update_id + 1);
        if (!Value.Check(telegramMessageSchema, update.message)) {
            await connection.receive(ctx, { state });
            return;
        }
        const message = update.message;
        const from = message.from;
        if (from === undefined) {
            await connection.receive(ctx, { state });
            return;
        }
        const userId = String(from.id);
        const direct = message.chat.type === "private";
        const largest = message.photo
            ?.filter((size) => (size.file_size ?? 0) <= MAX_TELEGRAM_DOWNLOAD_BYTES)
            .at(-1);
        let photo: string | undefined;
        let fetched: "attached" | "not_fetched" | undefined;
        if (
            largest !== undefined &&
            direct &&
            !from.is_bot &&
            (await connection.allows(ctx, userId))
        ) {
            const folder = this.#config.exportedBotFilesPath(this.kind, connection.account);
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const path = join(folder, `${String(update.update_id)}.jpg`);
            try {
                await api.download(ctx, largest.file_id, path);
                photo = path;
                fetched = "attached";
            } catch (error: unknown) {
                if (!(error instanceof TelegramApiError) || !error.permanent) throw error;
                fetched = "not_fetched";
            }
        }
        const event: InboundEvent = {
            state,
            message: {
                id: `${String(update.update_id)}:${String(message.chat.id)}:${String(message.message_id)}`,
                chatId: String(message.chat.id),
                direct,
                sender: {
                    id: userId,
                    name: [from.first_name, from.last_name ?? ""].join(" "),
                    ...(from.username === undefined ? {} : { username: from.username }),
                    isBot: from.is_bot,
                },
                text: telegramMessageText(message, fetched),
                ...(photo === undefined
                    ? {}
                    : {
                          attachments: [{ path: photo, mimeType: "image/jpeg", name: "photo.jpg" }],
                      }),
            },
        };
        try {
            await connection.receive(ctx, event);
        } finally {
            if (photo !== undefined) {
                await rm(photo, { force: true }).catch((error: unknown) => {
                    if (!isAbortedError(error)) {
                        ctx.log.warn("A received Telegram photo could not be removed.", {}, error);
                    }
                });
            }
        }
    }

    /** Text in Telegram-sized messages first, then each file on its own. */
    split(reply: ExportedBotReply): readonly ExportedBotReply[] {
        return [
            ...splitTelegramText(reply.text ?? "").map((text) => ({ text })),
            ...(reply.attachments ?? []).map((attachment) => ({ attachments: [attachment] })),
        ];
    }

    async send(
        ctx: Context,
        endpoint: ExportedBotEndpoint<TelegramSettings>,
        to: ExportedBotRecipient,
        piece: ExportedBotReply,
    ): Promise<void> {
        const api = this.#api(endpoint.settings);
        const chatId = telegramChatId(to.chatId);
        if (piece.text !== undefined) await api.sendMessage(ctx, chatId, piece.text);
        for (const attachment of piece.attachments ?? []) {
            const photo =
                attachment.image &&
                PHOTO_TYPES.has(attachment.mimeType) &&
                attachment.size <= MAX_TELEGRAM_PHOTO_UPLOAD_BYTES;
            if (!photo && attachment.size > MAX_TELEGRAM_FILE_UPLOAD_BYTES) {
                await api.sendMessage(
                    ctx,
                    chatId,
                    `(${attachment.name} is too large to send on Telegram; it is in Happy.)`,
                );
                continue;
            }
            await api.sendFile(ctx, chatId, photo ? "photo" : "document", attachment);
        }
    }

    tools(exportedBots: ExportedBotsModule, actingAgentId: string) {
        return [setTelegramExportedBotTool(exportedBots, actingAgentId, this)];
    }

    #api(settings: TelegramSettings): TelegramBotApi {
        return new TelegramBotApi(settings.token, this.#config.telegramApiUrl);
    }
}

/** A chat ID the export saved from Telegram, back in Telegram's numeric form. */
function telegramChatId(chatId: string): number {
    const id = Number(chatId);
    if (!/^-?[0-9]{1,20}$/.test(chatId) || !Number.isSafeInteger(id)) {
        throw new ExportedBotError("That chat is not a Telegram chat.", true);
    }
    return id;
}
