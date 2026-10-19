import type { IncomingMessage } from "node:http";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Smaller bodies go as they are: compressing them saves less than it costs. */
const COMPRESSED_BODY_MIN_BYTES = 64 * 1024;

export interface JsonResponseBody {
    readonly bytes: Buffer;
    readonly encoding?: "br" | "gzip";
}

/**
 * The bytes to send for one encoded JSON body: compressed when it is large and the client accepts
 * a compressed response, exactly as encoded otherwise.
 *
 * A local socket moves only a few kilobytes each event-loop turn, so a megabyte of history takes
 * hundreds of turns to leave a daemon that is busy streaming other agents. At the fastest setting
 * compression costs about a millisecond per half megabyte and leaves a sixth of the bytes.
 */
export function jsonResponseBody(
    request: IncomingMessage | undefined,
    encoded: string,
): JsonResponseBody {
    const bytes = Buffer.from(encoded, "utf8");
    if (bytes.byteLength < COMPRESSED_BODY_MIN_BYTES) return { bytes };
    const accepted = acceptedEncodings(request?.headers["accept-encoding"]);
    if (accepted.has("br")) {
        return {
            bytes: brotliCompressSync(bytes, {
                params: {
                    [constants.BROTLI_PARAM_QUALITY]: 1,
                    [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
                },
            }),
            encoding: "br",
        };
    }
    if (accepted.has("gzip")) return { bytes: gzipSync(bytes, { level: 1 }), encoding: "gzip" };
    return { bytes };
}

/** The content codings an `Accept-Encoding` header allows, ignoring any it gives a zero weight. */
function acceptedEncodings(header: string | undefined): ReadonlySet<string> {
    const accepted = new Set<string>();
    for (const entry of (header ?? "").split(",")) {
        const [name, ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
        if (name === undefined || name.length === 0) continue;
        const weight = parameters.find((parameter) => parameter.startsWith("q="));
        if (weight !== undefined && !(Number(weight.slice(2)) > 0)) continue;
        accepted.add(name);
    }
    return accepted;
}
