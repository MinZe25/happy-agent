import { createHash } from "node:crypto";
import { getImageProcessor } from "./getImageProcessor.js";
import { rgbaToThumbHash } from "./rgbaToThumbHash.js";

export const MAX_MANAGED_IMAGE_BYTES = 8 * 1024 * 1024;

/** A safe, user-facing failure to decode an offered managed image. */
export class ManagedImageInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ManagedImageInputError";
    }
}

/** The single normalization pipeline for node, bot, and Surface pictures. */
export async function normalizeManagedImage(
    bytes: Uint8Array,
    options: {
        maxPixels?: number;
        contentType?: "image/jpeg" | "image/png" | "image/webp";
    } = {},
) {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANAGED_IMAGE_BYTES) {
        throw new ManagedImageInputError("The image must be nonempty and no larger than 8 MiB.");
    }
    const maxPixels = options.maxPixels ?? 40_000_000;
    try {
        const processor = await getImageProcessor();
        const readOptions = { autoOrient: true, maxPixels };
        const metadata = await processor.metadata(bytes, readOptions);
        if (!["jpeg", "png", "webp"].includes(metadata.format)) {
            throw new ManagedImageInputError(
                "The image must be a readable PNG, JPEG, or WebP picture.",
            );
        }
        if (
            options.contentType !== undefined &&
            options.contentType !== `image/${metadata.format}`
        ) {
            throw new ManagedImageInputError("The image does not match its content type.");
        }
        const result = await processor.encode(bytes, {
            ...readOptions,
            format: "webp",
            quality: 82,
            resize: {
                filter: "lanczos3",
                fit: "inside",
                height: 256,
                width: 256,
                withoutEnlargement: true,
            },
        });
        const placeholder = await processor.rgba(result.data, {
            autoOrient: false,
            maxPixels,
            resize: {
                filter: "lanczos3",
                fit: "inside",
                height: 100,
                width: 100,
                withoutEnlargement: true,
            },
        });
        const contentHash = createHash("sha256").update(result.data).digest("hex");
        return {
            bytes: new Uint8Array(result.data),
            contentHash,
            etag: `"${contentHash}"`,
            height: result.height,
            width: result.width,
            thumbhash: Buffer.from(
                rgbaToThumbHash(placeholder.width, placeholder.height, placeholder.data),
            ).toString("base64"),
        };
    } catch (error) {
        if (error instanceof ManagedImageInputError) throw error;
        throw new ManagedImageInputError(
            `The image must be a readable PNG, JPEG, or WebP with at most ${maxPixels / 1_000_000} million pixels.`,
        );
    }
}
