import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

import {
    ApiArtifactData,
    ApiError,
    ARTIFACT_DATA_DEVELOPMENT_DEFAULT_USER,
    ArtifactDataDevelopment,
    artifactDataDumpSchema,
    artifactLogLevelSchema,
    type ArtifactDataDump,
} from "@slopus/happy-agent-modules";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import {
    artifactDevFaultsPatchSchema,
    NO_ARTIFACT_DEV_FAULTS,
    type ArtifactDevFaults,
} from "./ArtifactDevFaults.js";
import { ARTIFACT_DEV_PANEL } from "./artifactDevPanel.js";

/** Requests the development server remembers for `/__happy/requests`. */
const MAX_REQUEST_LOG = 500;
/** What a control request may send. */
const MAX_CONTROL_BODY_BYTES = 32 * 1024 * 1024;

const userNameSchema = Type.String({ minLength: 1, maxLength: 40 });
const nameBodySchema = Type.Object({ name: userNameSchema }, { additionalProperties: false });
const seedBodySchema = Type.Object(
    {
        values: Type.Record(Type.String(), Type.Unknown()),
        as: Type.Optional(userNameSchema),
    },
    { additionalProperties: false },
);
const writeBodySchema = Type.Object(
    {
        key: Type.String(),
        value: Type.Optional(Type.Unknown()),
        delete: Type.Optional(Type.Literal(true)),
        as: Type.Optional(userNameSchema),
    },
    { additionalProperties: false },
);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".wasm": "application/wasm",
    ".pdf": "application/pdf",
};

export interface ArtifactDevServerOptions {
    /** The artifact's files, served at `/`. */
    readonly folder: string;
    /** Where the data and debug log live. */
    readonly scratch: string;
    readonly host: string;
    /** `0` picks a free port. */
    readonly port: number;
    /** The artifact the data belongs to; it only names the files and the dump. */
    readonly artifactId: string;
    /** Data to start from instead of what `scratch` holds. */
    readonly seed?: ArtifactDataDump | { readonly values: Readonly<Record<string, unknown>> };
}

/** One request the server answered, as the control surface reports it. */
export interface ArtifactDevRequest {
    readonly id: number;
    readonly at: number;
    readonly method: string;
    readonly path: string;
    readonly user: string;
    status: number | null;
    ms: number | null;
    fault: "offline" | "failed" | "dropped" | "cut" | null;
}

export interface ArtifactDevServer {
    readonly url: string;
    readonly data: ArtifactDataDevelopment;
    close(): Promise<void>;
}

/**
 * Serve an artifact folder with the real artifact data API at `/api/*` and controls at
 * `/__happy/`, outside any daemon. Pages behave as they would in a client: the same SDK, routes,
 * versions, and limits answer them, while made-up people and injected network faults let one
 * developer see what several people on bad connections would.
 */
export async function startArtifactDevServer(
    options: ArtifactDevServerOptions,
): Promise<ArtifactDevServer> {
    const root = createRootContext();
    const folder = resolve(options.folder);
    const data = new ArtifactDataDevelopment(options.scratch, options.artifactId);
    const streams: ConstructorParameters<typeof ApiArtifactData>[1] = new Set();
    const api = new ApiArtifactData(data, streams);
    const streamResponses = new Set<ServerResponse>();
    const requests: ArtifactDevRequest[] = [];
    let nextRequestId = 1;
    let faults: ArtifactDevFaults = { ...NO_ARTIFACT_DEV_FAULTS };

    if (options.seed !== undefined) {
        if ("format" in options.seed) {
            await data.load(root, options.seed);
        } else {
            await data.reset(root);
            await seedValues(root, data, options.seed.values, undefined);
        }
    }
    data.user(ARTIFACT_DATA_DEVELOPMENT_DEFAULT_USER);

    const cutStreams = (): number => {
        const open = [...streamResponses];
        for (const response of open) response.destroy();
        streamResponses.clear();
        return open.length;
    };

    const handleData = async (
        request: IncomingMessage,
        response: ServerResponse,
        path: string,
    ): Promise<void> => {
        const name = callerName(request);
        const ctx = data.as(root, name);
        const route = path.slice("/api/v1/".length).split("?")[0] ?? "";
        const logged: ArtifactDevRequest = {
            id: nextRequestId++,
            at: Date.now(),
            method: request.method ?? "GET",
            path,
            user: data.user(name).name ?? name,
            status: null,
            ms: null,
            fault: null,
        };
        requests.push(logged);
        if (requests.length > MAX_REQUEST_LOG) requests.shift();
        response.once("close", () => {
            logged.ms = Date.now() - logged.at;
            if (logged.status === null && logged.fault === null) {
                logged.status = response.headersSent ? response.statusCode : null;
            }
        });
        const counted = route !== "client.js" && route !== "debug/log";
        const stream = route === "kv/events";
        if (faults.offline && counted) {
            logged.fault = "offline";
            request.socket.destroy();
            return;
        }
        if (faults.latencyMs > 0) await sleep(faults.latencyMs);
        if (counted && faults.failNext > 0) {
            faults = { ...faults, failNext: faults.failNext - 1 };
            logged.fault = "failed";
            logged.status = 503;
            sendJson(response, 503, {
                code: "unavailable",
                error: "The development server failed this request on purpose.",
            });
            return;
        }
        const drop = counted && !stream && faults.dropNext > 0;
        if (drop) {
            faults = { ...faults, dropNext: faults.dropNext - 1 };
            logged.fault = "dropped";
            // The request is applied in full; only its answer never leaves.
            swallow(response);
        }
        if (stream) {
            streamResponses.add(response);
            response.once("close", () => streamResponses.delete(response));
        }
        request.url = `/v0/artifacts/${options.artifactId}${path}`;
        try {
            await api.handle(ctx, request, response);
        } catch (error: unknown) {
            if (error instanceof ApiError) {
                logged.status = error.status;
                sendJsonOnce(response, error.status, error.body());
            } else {
                logged.status = 500;
                sendJsonOnce(response, 500, {
                    code: "internal",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (drop) request.socket.destroy();
    };

    const handleControl = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<void> => {
        const method = request.method ?? "GET";
        const route = url.pathname.slice("/__happy".length);
        if ((route === "" || route === "/") && method === "GET") {
            const body = Buffer.from(ARTIFACT_DEV_PANEL, "utf8");
            response.writeHead(200, {
                "cache-control": "no-store",
                "content-length": body.byteLength,
                "content-type": "text/html; charset=utf-8",
            });
            response.end(body);
            return;
        }
        if (route === "/state" && method === "GET") {
            return sendJson(response, 200, {
                artifactId: options.artifactId,
                folder,
                scratch: options.scratch,
                faults,
                streams: streamResponses.size,
                users: data.knownUsers(),
            });
        }
        if (route === "/faults" && method === "POST") {
            const body = await readControlJson(request);
            if (!Value.Check(artifactDevFaultsPatchSchema, body)) {
                throw new ApiError(
                    400,
                    "invalid_request",
                    "Send any of offline, latencyMs, failNext, and dropNext.",
                );
            }
            faults = { ...faults, ...body };
            if (faults.offline) cutStreams();
            return sendJson(response, 200, { faults });
        }
        if (route === "/streams/cut" && method === "POST") {
            return sendJson(response, 200, { cut: cutStreams() });
        }
        if (route === "/users" && method === "GET") {
            return sendJson(response, 200, { users: data.knownUsers() });
        }
        if (route === "/users" && method === "POST") {
            const body = await readControlJson(request);
            if (!Value.Check(nameBodySchema, body)) {
                throw new ApiError(400, "invalid_request", "Send `{ name }`, 1–40 characters.");
            }
            return sendJson(response, 200, { user: data.user(body.name) });
        }
        if (route === "/data" && method === "GET") {
            return sendJson(response, 200, await data.dump(root));
        }
        if (route === "/data" && method === "PUT") {
            const body = await readControlJson(request);
            if (!Value.Check(artifactDataDumpSchema, body)) {
                throw new ApiError(400, "invalid_request", "Send a dump from GET /__happy/data.");
            }
            await data.load(root, body);
            cutStreams();
            return sendJson(response, 200, { entries: body.entries.length });
        }
        if (route === "/data/reset" && method === "POST") {
            await data.reset(root);
            cutStreams();
            return sendJson(response, 200, { reset: true });
        }
        if (route === "/data/seed" && method === "POST") {
            const body = await readControlJson(request);
            if (!Value.Check(seedBodySchema, body)) {
                throw new ApiError(
                    400,
                    "invalid_request",
                    "Send `{ values: { key: value }, as? }`.",
                );
            }
            return sendJson(response, 200, {
                written: await seedValues(root, data, body.values, body.as),
            });
        }
        if (route === "/data/write" && method === "POST") {
            const body = await readControlJson(request);
            if (
                !Value.Check(writeBodySchema, body) ||
                (body.delete === true) === Object.hasOwn(body, "value")
            ) {
                throw new ApiError(
                    400,
                    "invalid_request",
                    "Send `{ key, value, as? }` to write, or `{ key, delete: true, as? }` to delete.",
                );
            }
            const author = {
                kind: "user" as const,
                userId: data.user(body.as ?? ARTIFACT_DATA_DEVELOPMENT_DEFAULT_USER).id,
            };
            const written =
                body.delete === true
                    ? await data.delete(root, options.artifactId, { key: body.key, author })
                    : await data.set(root, options.artifactId, {
                          key: body.key,
                          value: body.value,
                          author,
                      });
            return sendJson(response, 200, written);
        }
        if (route === "/requests" && method === "GET") {
            return sendJson(response, 200, { requests: [...requests].reverse() });
        }
        if (route === "/requests" && method === "DELETE") {
            requests.length = 0;
            return sendJson(response, 200, { cleared: true });
        }
        if (route === "/logs" && method === "GET") {
            const level = url.searchParams.get("level") ?? undefined;
            const user = url.searchParams.get("user") ?? undefined;
            const limit = url.searchParams.get("limit") ?? undefined;
            const before = url.searchParams.get("pageCursor") ?? undefined;
            if (level !== undefined && !Value.Check(artifactLogLevelSchema, level)) {
                throw new ApiError(400, "invalid_request", "`level` is error, warn, or info.");
            }
            const page = await data.readLogs(root, {
                ...(level === undefined ? {} : { level }),
                ...(user === undefined ? {} : { userId: data.user(user).id }),
                ...(limit === undefined ? {} : { limit: Number(limit) }),
                ...(before === undefined ? {} : { before }),
            });
            const names = new Map(data.knownUsers().map((known) => [known.id, known.name]));
            return sendJson(response, 200, {
                entries: page.entries.map((entry) => ({
                    ...entry,
                    user: names.get(entry.userId) ?? null,
                })),
                nextPageCursor: page.nextBefore ?? null,
            });
        }
        if (route === "/logs" && method === "DELETE") {
            await data.clearLogs(root);
            return sendJson(response, 200, { cleared: true });
        }
        throw new ApiError(404, "not_found", "The development server has no such control.");
    };

    const handleFile = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
    ): Promise<void> => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            throw new ApiError(405, "invalid_request", "Files are only read.");
        }
        let relative: string;
        try {
            relative = decodeURIComponent(url.pathname);
        } catch {
            throw new ApiError(400, "invalid_request", "The path is not valid.");
        }
        let path = resolve(folder, `.${relative}`);
        if (path !== folder && !path.startsWith(folder + sep)) {
            throw new ApiError(404, "not_found", "No such file.");
        }
        let info = await stat(path).catch(() => undefined);
        if (info?.isDirectory() === true) {
            path = join(path, "index.html");
            info = await stat(path).catch(() => undefined);
        }
        if (info === undefined || !info.isFile()) {
            throw new ApiError(404, "not_found", "No such file.");
        }
        response.writeHead(200, {
            "cache-control": "no-store",
            "content-length": info.size,
            "content-type":
                CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        });
        if (request.method === "HEAD") {
            response.end();
            return;
        }
        createReadStream(path).pipe(response);
    };

    const server = createServer((request, response) => {
        const target = request.url ?? "/";
        const url = new URL(target, "http://localhost");
        const work = target.startsWith("/api/")
            ? handleData(request, response, target)
            : url.pathname === "/__happy" || url.pathname.startsWith("/__happy/")
              ? handleControl(request, response, url)
              : handleFile(request, response, url);
        work.catch((error: unknown) => {
            if (error instanceof ApiError) sendJsonOnce(response, error.status, error.body());
            else {
                sendJsonOnce(response, 500, {
                    code: "internal",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
    });
    await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
            server.off("error", reject);
            resolveListen();
        });
    });
    const address = server.address() as AddressInfo;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

    return {
        url: `http://${host}:${String(address.port)}`,
        data,
        close: async () => {
            cutStreams();
            for (const writer of streams) writer.close();
            await new Promise<void>((resolveClose) => {
                server.close(() => resolveClose());
                server.closeAllConnections();
            });
            await data.close(root);
        },
    };
}

/**
 * Who a request is made by: `X-Happy-Dev-User`, which the SDK sends, then the `as` of the page
 * that asked, for scripts and images it loads, then the `happy_dev_user` cookie, then you.
 */
function callerName(request: IncomingMessage): string {
    const header = request.headers["x-happy-dev-user"];
    const named = typeof header === "string" ? header.trim() : "";
    if (named !== "" && named.length <= 40) return named;
    try {
        const referred = new URL(request.headers.referer ?? "").searchParams.get("as")?.trim();
        if (referred !== undefined && referred !== "" && referred.length <= 40) return referred;
    } catch {
        // A request no page made names nobody this way.
    }
    for (const part of (request.headers.cookie ?? "").split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name !== "happy_dev_user") continue;
        try {
            const cookie = decodeURIComponent(value.join("=")).trim();
            if (cookie !== "" && cookie.length <= 40) return cookie;
        } catch {
            // An unreadable cookie names nobody.
        }
    }
    return ARTIFACT_DATA_DEVELOPMENT_DEFAULT_USER;
}

async function seedValues(
    ctx: Context,
    data: ArtifactDataDevelopment,
    values: Readonly<Record<string, unknown>>,
    as: string | undefined,
): Promise<number> {
    const author = {
        kind: "user" as const,
        userId: data.user(as ?? ARTIFACT_DATA_DEVELOPMENT_DEFAULT_USER).id,
    };
    let written = 0;
    for (const [key, value] of Object.entries(values)) {
        await data.set(ctx, data.artifactId, { key, value, author });
        written += 1;
    }
    return written;
}

/** Let a handler run to completion while nothing it writes reaches the connection. */
function swallow(response: ServerResponse): void {
    response.writeHead = (() => response) as unknown as ServerResponse["writeHead"];
    response.setHeader = (() => response) as unknown as ServerResponse["setHeader"];
    response.write = (() => true) as unknown as ServerResponse["write"];
    response.end = (() => response) as unknown as ServerResponse["end"];
}

async function readControlJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.byteLength;
        if (bytes > MAX_CONTROL_BODY_BYTES) {
            throw new ApiError(413, "too_large", "The request body is larger than 32 MiB.");
        }
        chunks.push(buffer);
    }
    if (bytes === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new ApiError(400, "invalid_request", "The request body must be valid JSON.");
    }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(encoded),
        "content-type": "application/json; charset=utf-8",
    });
    response.end(encoded);
}

function sendJsonOnce(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.destroyed) {
        response.end();
        return;
    }
    sendJson(response, status, body);
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
