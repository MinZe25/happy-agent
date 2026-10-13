import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AbortedError, createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    TelegramApiError,
    TelegramBotApi,
} from "../../sources/exportedBots/telegram/TelegramBotApi.js";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const SECRET = TOKEN.slice(TOKEN.indexOf(":") + 1);

interface Request {
    readonly path: string;
    readonly body: unknown;
    readonly contentType: string;
}

type Answer = (
    request: Request,
) =>
    | { readonly status: number; readonly body: unknown }
    | { readonly status: number; readonly raw: Buffer }
    | "hang";

let server: Server | undefined;

afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
        server === undefined ? resolve() : server.close(() => resolve()),
    );
    server = undefined;
});

/** A Bot API stand-in on loopback that answers each request with `answer`. */
async function botApi(answer: Answer): Promise<{ url: string; requests: Request[] }> {
    const requests: Request[] = [];
    server = createServer(async (incoming: IncomingMessage, response) => {
        let text = "";
        for await (const chunk of incoming) text += String(chunk);
        const contentType = incoming.headers["content-type"] ?? "";
        const request = {
            path: incoming.url ?? "",
            body: text === "" ? undefined : contentType.includes("json") ? JSON.parse(text) : text,
            contentType,
        };
        requests.push(request);
        const result = answer(request);
        if (result === "hang") return;
        if ("raw" in result) {
            response.writeHead(result.status, { "content-type": "application/octet-stream" });
            response.end(result.raw);
            return;
        }
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}`, requests };
}

async function failure(promise: Promise<unknown>): Promise<TelegramApiError> {
    try {
        await promise;
    } catch (error: unknown) {
        if (error instanceof TelegramApiError) return error;
        throw error;
    }
    throw new Error("The call succeeded.");
}

describe("the Telegram Bot API client", () => {
    it("calls methods under the bot's token and returns their results", async () => {
        const { url, requests } = await botApi((request) =>
            request.path.endsWith("/getMe")
                ? {
                      status: 200,
                      body: {
                          ok: true,
                          result: {
                              id: 1,
                              is_bot: true,
                              first_name: "Happy",
                              username: "happy_bot",
                          },
                      },
                  }
                : {
                      status: 200,
                      body: { ok: true, result: [{ update_id: 7, message: { anything: true } }] },
                  },
        );
        const api = new TelegramBotApi(TOKEN, `${url}/`);
        const ctx = createRootContext();

        await expect(api.getMe(ctx)).resolves.toMatchObject({ username: "happy_bot" });
        await expect(api.getUpdates(ctx, 7, 0)).resolves.toEqual([
            { update_id: 7, message: { anything: true } },
        ]);
        expect(requests.map((request) => request.path)).toEqual([
            `/bot${TOKEN}/getMe`,
            `/bot${TOKEN}/getUpdates`,
        ]);
        expect(requests[1]!.body).toEqual({ offset: 7, timeout: 0, allowed_updates: ["message"] });
    });

    it("treats a rejected token as permanent and never repeats it", async () => {
        const { url } = await botApi(() => ({
            status: 401,
            body: { ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` },
        }));
        const error = await failure(new TelegramBotApi(TOKEN, url).getMe(createRootContext()));

        expect(error.permanent).toBe(true);
        expect(error.message).toContain("Telegram rejected the bot token");
        expect(error.message).not.toContain(SECRET);
        expect(error.cause).toBeUndefined();
    });

    it("carries Telegram's requested wait when it asks to slow down", async () => {
        const { url } = await botApi(() => ({
            status: 429,
            body: {
                ok: false,
                error_code: 429,
                description: "Too Many Requests",
                parameters: { retry_after: 3 },
            },
        }));
        const error = await failure(
            new TelegramBotApi(TOKEN, url).sendMessage(createRootContext(), 42, "hi"),
        );

        expect(error.permanent).toBe(false);
        expect(error.retryAfterMs).toBe(3_000);
    });

    it("separates retryable server failures from refusals", async () => {
        const { url } = await botApi((request) =>
            request.path.endsWith("/sendMessage")
                ? {
                      status: 400,
                      body: {
                          ok: false,
                          error_code: 400,
                          description: "Bad Request: chat not found",
                      },
                  }
                : { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } },
        );
        const api = new TelegramBotApi(TOKEN, url);
        const ctx = createRootContext();

        const refused = await failure(api.sendMessage(ctx, 42, "hi"));
        expect(refused.permanent).toBe(true);
        expect(refused.message).toContain("chat not found");
        const unavailable = await failure(api.getMe(ctx));
        expect(unavailable.permanent).toBe(false);
    });

    it("removes the token from failures that never reached Telegram", async () => {
        const error = await failure(
            new TelegramBotApi(TOKEN, "http://bad host").getMe(createRootContext()),
        );

        expect(error.permanent).toBe(false);
        expect(error.message).toContain("Telegram could not be reached");
        expect(error.message).not.toContain(SECRET);
        expect(error.cause).toBeUndefined();
    });

    it("stops a long poll when its lifetime ends", async () => {
        const { url, requests } = await botApi(() => "hang");
        const controller = new AbortController();
        const ctx = withLifetime(createRootContext(), controller.signal);
        const polling = new TelegramBotApi(TOKEN, url).getUpdates(ctx, undefined, 50);
        await expect.poll(() => requests.length).toBe(1);

        controller.abort();

        await expect(polling).rejects.toBeInstanceOf(AbortedError);
    });

    it("downloads a file someone sent into a private file", async () => {
        const folder = await mkdtemp(join(tmpdir(), "telegram-file-"));
        try {
            const { url, requests } = await botApi((request) =>
                request.path.endsWith("/getFile")
                    ? { status: 200, body: { ok: true, result: { file_path: "photos/a.jpg" } } }
                    : { status: 200, raw: Buffer.from("picture bytes") },
            );
            const destination = join(folder, "1.jpg");
            await new TelegramBotApi(TOKEN, url).download(
                createRootContext(),
                "file-1",
                destination,
            );

            expect(await readFile(destination, "utf8")).toBe("picture bytes");
            expect((await stat(destination)).mode & 0o777).toBe(0o600);
            expect(requests.map((request) => request.path)).toEqual([
                `/bot${TOKEN}/getFile`,
                `/file/bot${TOKEN}/photos/a.jpg`,
            ]);
            expect(requests[0]!.body).toEqual({ file_id: "file-1" });
        } finally {
            await rm(folder, { recursive: true, force: true });
        }
    });

    it("uploads a file as a photo with its name", async () => {
        const folder = await mkdtemp(join(tmpdir(), "telegram-upload-"));
        try {
            const path = join(folder, "snapshot");
            await writeFile(path, "png bytes");
            const { url, requests } = await botApi(() => ({
                status: 200,
                body: { ok: true, result: { message_id: 3 } },
            }));
            await new TelegramBotApi(TOKEN, url).sendFile(createRootContext(), 42, "photo", {
                path,
                name: "chart.png",
                mimeType: "image/png",
            });

            expect(requests[0]!.path).toBe(`/bot${TOKEN}/sendPhoto`);
            expect(requests[0]!.contentType).toContain("multipart/form-data");
            expect(requests[0]!.body).toContain('name="photo"; filename="chart.png"');
            expect(requests[0]!.body).toContain("png bytes");
            expect(requests[0]!.body).toContain('name="chat_id"');
        } finally {
            await rm(folder, { recursive: true, force: true });
        }
    });
});
