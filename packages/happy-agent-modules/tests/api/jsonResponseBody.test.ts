import type { IncomingMessage } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { jsonResponseBody } from "../../sources/api/impl/jsonResponseBody.js";

const large = JSON.stringify({ runs: Array.from({ length: 10_000 }, (_, index) => ({ index })) });
const accepting = (header?: string) =>
    ({ headers: header === undefined ? {} : { "accept-encoding": header } }) as IncomingMessage;

describe("jsonResponseBody", () => {
    it("compresses a large body the way the client asks, preferring Brotli", () => {
        const brotli = jsonResponseBody(accepting("gzip, deflate, br, zstd"), large);
        expect(brotli.encoding).toBe("br");
        expect(brotli.bytes.byteLength).toBeLessThan(large.length / 4);
        expect(brotliDecompressSync(brotli.bytes).toString("utf8")).toBe(large);

        const gzip = jsonResponseBody(accepting("gzip;q=1, br;q=0"), large);
        expect(gzip.encoding).toBe("gzip");
        expect(gunzipSync(gzip.bytes).toString("utf8")).toBe(large);
    });

    it("sends small bodies and clients that accept no compression the body as encoded", () => {
        for (const [request, body] of [
            [accepting("br"), JSON.stringify({ ok: true })],
            [accepting(), large],
            [accepting("identity, br;q=0, gzip;q=0.0"), large],
            [undefined, large],
        ] as const) {
            const sent = jsonResponseBody(request, body);
            expect(sent.encoding).toBeUndefined();
            expect(sent.bytes.toString("utf8")).toBe(body);
        }
    });
});
