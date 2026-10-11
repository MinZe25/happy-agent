import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import { rgbaToThumbHash } from "../../impl/images/rgbaToThumbHash.js";

const MAX_DECODED_PIXELS = 40_000_000;

/** Decoded formats a client shows as a picture, with the media type it is served under. */
const DISPLAYABLE_FORMATS: Readonly<Record<string, string>> = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
};

export interface MeasuredChatImage {
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
    readonly thumbhash: string;
}

/**
 * Prove the bytes are a picture a client can show and measure it as displayed.
 *
 * The decoder decides the format, so a misnamed file is served as what it really is. Decoding
 * the placeholder reads the whole picture under the pixel bound, which is the proof. A file that
 * does not decode, or decodes to a format clients cannot show, is not an image.
 */
export async function measureChatImage(
    bytes: Uint8Array,
    declaredMimeType: string,
): Promise<MeasuredChatImage | undefined> {
    try {
        const processor = await getImageProcessor();
        const options = { autoOrient: true, maxPixels: MAX_DECODED_PIXELS };
        const metadata = await processor.metadata(bytes, options);
        // AVIF and HEIC both decode as HEIF; only AVIF is a picture clients show.
        const mimeType =
            metadata.format === "heif" && declaredMimeType === "image/avif"
                ? "image/avif"
                : DISPLAYABLE_FORMATS[metadata.format];
        if (mimeType === undefined || metadata.width < 1 || metadata.height < 1) return undefined;
        const placeholder = await processor.rgba(bytes, {
            ...options,
            resize: {
                filter: "linear",
                fit: "inside",
                height: 100,
                width: 100,
                withoutEnlargement: true,
            },
        });
        return {
            mimeType,
            width: metadata.width,
            height: metadata.height,
            thumbhash: Buffer.from(
                rgbaToThumbHash(placeholder.width, placeholder.height, placeholder.data),
            ).toString("base64"),
        };
    } catch {
        return undefined;
    }
}
