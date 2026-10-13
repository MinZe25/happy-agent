import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AbortedError, type Context } from "@steve.kite/stdlib";

import { ExportedBotError } from "../ExportedBotAdapter.js";

/** Telegram adds fields freely, so these schemas name only what Happy Agent reads. */
export const telegramUserSchema = Type.Object({
    id: Type.Integer(),
    is_bot: Type.Boolean(),
    first_name: Type.String(),
    last_name: Type.Optional(Type.String()),
    username: Type.Optional(Type.String()),
});
export type TelegramUser = Static<typeof telegramUserSchema>;

/** One size of a photo. A photo arrives as several, smallest first. */
export const telegramPhotoSizeSchema = Type.Object({
    file_id: Type.String({ minLength: 1, maxLength: 1_024 }),
    width: Type.Integer(),
    height: Type.Integer(),
    file_size: Type.Optional(Type.Integer()),
});

export const telegramMessageSchema = Type.Object({
    message_id: Type.Integer(),
    date: Type.Integer(),
    chat: Type.Object({ id: Type.Integer(), type: Type.String() }),
    from: Type.Optional(telegramUserSchema),
    text: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
    photo: Type.Optional(Type.Array(telegramPhotoSizeSchema, { maxItems: 32 })),
});
export type TelegramMessage = Static<typeof telegramMessageSchema>;

/** One update. Its payload is checked separately so one odd update cannot stall the stream. */
export const telegramUpdateSchema = Type.Object({
    update_id: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    message: Type.Optional(Type.Unknown()),
});
export type TelegramUpdate = Static<typeof telegramUpdateSchema>;

const fileSchema = Type.Object({
    file_path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    file_size: Type.Optional(Type.Integer()),
});

const successSchema = Type.Object({ ok: Type.Literal(true), result: Type.Unknown() });

const failureSchema = Type.Object({
    ok: Type.Literal(false),
    error_code: Type.Optional(Type.Integer()),
    description: Type.Optional(Type.String()),
    parameters: Type.Optional(
        Type.Object({ retry_after: Type.Optional(Type.Integer({ minimum: 0 })) }),
    ),
});

/** The most a Bot API response may hold; a full page of updates is far smaller. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The Bot API serves files of at most 20 MB to bots. */
export const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** The largest photo, and the largest other file, a bot may upload. */
export const MAX_TELEGRAM_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_TELEGRAM_FILE_UPLOAD_BYTES = 50 * 1024 * 1024;

/** A Bot API failure. Its message never contains the token. */
export class TelegramApiError extends ExportedBotError {
    constructor(message: string, permanent: boolean, retryAfterMs?: number) {
        super(message, permanent, retryAfterMs);
        this.name = "TelegramApiError";
    }
}

/**
 * The few Bot API methods a Telegram export needs, over plain HTTPS.
 *
 * The token is part of every request path, so nothing this class throws may carry a request,
 * response, URL, or underlying error: each failure is rebuilt as a `TelegramApiError` whose
 * message has the token removed.
 */
export class TelegramBotApi {
    readonly #token: string;
    readonly #apiUrl: string;

    constructor(token: string, apiUrl: string) {
        this.#token = token;
        this.#apiUrl = apiUrl.replace(/\/+$/, "");
    }

    async getMe(ctx: Context): Promise<TelegramUser> {
        return await this.#call(ctx, "getMe", jsonBody({}), telegramUserSchema, 20_000);
    }

    /** Long-poll for new messages. `offset` confirms every update before it. */
    async getUpdates(
        ctx: Context,
        offset: number | undefined,
        timeoutSeconds: number,
    ): Promise<readonly TelegramUpdate[]> {
        return await this.#call(
            ctx,
            "getUpdates",
            jsonBody({
                ...(offset === undefined ? {} : { offset }),
                timeout: timeoutSeconds,
                allowed_updates: ["message"],
            }),
            Type.Array(telegramUpdateSchema, { maxItems: 100 }),
            (timeoutSeconds + 15) * 1_000,
        );
    }

    async sendMessage(ctx: Context, chatId: number, text: string): Promise<void> {
        await this.#call(
            ctx,
            "sendMessage",
            jsonBody({ chat_id: chatId, text }),
            Type.Unknown(),
            30_000,
        );
    }

    async sendTyping(ctx: Context, chatId: number): Promise<void> {
        await this.#call(
            ctx,
            "sendChatAction",
            jsonBody({ chat_id: chatId, action: "typing" }),
            Type.Unknown(),
            5_000,
        );
    }

    /** Upload one file from this machine as a photo, or as a document Telegram keeps as it is. */
    async sendFile(
        ctx: Context,
        chatId: number,
        as: "photo" | "document",
        file: { readonly path: string; readonly name: string; readonly mimeType: string },
    ): Promise<void> {
        let blob: Blob;
        try {
            blob = await openAsBlob(file.path, { type: file.mimeType });
        } catch {
            throw new TelegramApiError("The file to send no longer exists.", true);
        }
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set(as, blob, file.name);
        await this.#call(
            ctx,
            as === "photo" ? "sendPhoto" : "sendDocument",
            { body: form },
            Type.Unknown(),
            120_000,
        );
    }

    /** Download a file someone sent, such as a photo, to `destination`. */
    async download(ctx: Context, fileId: string, destination: string): Promise<void> {
        const file = await this.#call(
            ctx,
            "getFile",
            jsonBody({ file_id: fileId }),
            fileSchema,
            20_000,
        );
        if (file.file_path === undefined || (file.file_size ?? 0) > MAX_TELEGRAM_DOWNLOAD_BYTES) {
            throw new TelegramApiError("Telegram cannot hand over a file this large.", true);
        }
        const bytes = await this.#fetch(
            ctx,
            `${this.#apiUrl}/file/bot${this.#token}/${file.file_path}`,
            { method: "GET" },
            60_000,
            MAX_TELEGRAM_DOWNLOAD_BYTES,
        );
        if (bytes.status !== 200) {
            throw new TelegramApiError(
                `Telegram did not hand over the file (HTTP ${String(bytes.status)}).`,
                bytes.status === 404,
            );
        }
        await writeFile(destination, bytes.body, { mode: 0o600 });
    }

    async #call<Result extends TSchema>(
        ctx: Context,
        method: string,
        request: { readonly body: string | FormData; readonly contentType?: string },
        resultSchema: Result,
        timeoutMs: number,
    ): Promise<Static<Result>> {
        const { status, body } = await this.#fetch(
            ctx,
            `${this.#apiUrl}/bot${this.#token}/${method}`,
            {
                method: "POST",
                headers:
                    request.contentType === undefined
                        ? {}
                        : { "content-type": request.contentType },
                body: request.body,
            },
            timeoutMs,
            MAX_RESPONSE_BYTES,
        );
        let payload: unknown;
        try {
            payload = JSON.parse(new TextDecoder().decode(body));
        } catch {
            throw new TelegramApiError(
                `Telegram answered ${method} with something that is not a Bot API response (HTTP ${String(status)}).`,
                status >= 400 && status < 500 && status !== 429,
            );
        }
        if (Value.Check(failureSchema, payload)) {
            throw this.#failure(method, payload.error_code ?? status, payload);
        }
        if (Value.Check(successSchema, payload)) {
            if (!Value.Check(resultSchema, payload.result)) {
                throw new TelegramApiError(
                    `Telegram answered ${method} with an unexpected result.`,
                    false,
                );
            }
            return payload.result as Static<Result>;
        }
        throw new TelegramApiError(
            `Telegram answered ${method} with something that is not a Bot API response (HTTP ${String(status)}).`,
            false,
        );
    }

    async #fetch(
        ctx: Context,
        url: string,
        init: RequestInit,
        timeoutMs: number,
        maxBytes: number,
    ): Promise<{ readonly status: number; readonly body: Uint8Array }> {
        const lifetime = ctx.lifetime;
        if (isAborted(lifetime)) throw new AbortedError();
        const signal =
            lifetime === undefined
                ? AbortSignal.timeout(timeoutMs)
                : AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs)]);
        try {
            const response = await fetch(url, { ...init, signal });
            return { status: response.status, body: await readBounded(response, maxBytes) };
        } catch (error: unknown) {
            if (isAborted(lifetime)) throw new AbortedError();
            if (signal.aborted) {
                throw new TelegramApiError("Telegram did not answer in time.", false);
            }
            throw new TelegramApiError(
                `Telegram could not be reached: ${this.#redact(describe(error))}`,
                false,
            );
        }
    }

    #failure(
        method: string,
        code: number,
        payload: Static<typeof failureSchema>,
    ): TelegramApiError {
        const detail = this.#redact(payload.description ?? "").slice(0, 300);
        const said = detail === "" ? "" : ` Telegram said: ${detail}`;
        if (code === 401 || code === 404) {
            return new TelegramApiError(
                `Telegram rejected the bot token. Ask for the current token from @BotFather and set it with set_telegram_exported_bot.${said}`,
                true,
            );
        }
        if (code === 409) {
            return new TelegramApiError(
                `Another program is reading this bot's messages, or the bot has a webhook. Stop the other program or remove the webhook.${said}`,
                false,
            );
        }
        if (code === 429) {
            const seconds = payload.parameters?.retry_after ?? 1;
            return new TelegramApiError(
                `Telegram asked to slow down for ${String(seconds)} seconds.`,
                false,
                seconds * 1_000,
            );
        }
        if (code >= 400 && code < 500) {
            return new TelegramApiError(`Telegram refused ${method}.${said}`, true);
        }
        return new TelegramApiError(`Telegram failed to handle ${method}.${said}`, false);
    }

    /** Remove the token, and its secret half on its own, from text that came from elsewhere. */
    #redact(text: string): string {
        const secret = this.#token.slice(this.#token.indexOf(":") + 1);
        return text.replaceAll(this.#token, "<token>").replaceAll(secret, "<token>");
    }
}

function jsonBody(body: Readonly<Record<string, unknown>>): {
    readonly body: string;
    readonly contentType: string;
} {
    return { body: JSON.stringify(body), contentType: "application/json" };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw new Error("The Bot API response is too large.");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** A call, so the check after `await` is not narrowed away by the one before it. */
function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

function describe(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const cause =
        error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${message}${cause}`.replaceAll(/\s+/g, " ").slice(0, 300);
}
