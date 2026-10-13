import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

import type { SessionImageBlock } from "@slopus/happy-providers";

import { ImageProcessingError } from "../../impl/images/ImageProcessingError.js";
import { prepareImageForPrompt } from "../../impl/images/prepareImageForPrompt.js";
import type { InboundAttachment } from "../ExportedBotAdapter.js";

/** The most files one message may carry. */
export const MAX_INBOUND_ATTACHMENTS = 10;
/** The largest file a message may carry. */
export const MAX_INBOUND_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** Pictures are sent at no more than this on their longest side, and this many bytes. */
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

/** A file that cannot be taken in, whatever is tried again. */
export class InboundAttachmentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InboundAttachmentError";
    }
}

/** What a message's files become: pictures the agent sees, and notes naming the rest. */
export interface InboundFiles {
    readonly images: readonly SessionImageBlock[];
    readonly notes: readonly string[];
}

/**
 * Check every file a message names and read the pictures. A path must be absolute and name a
 * regular file — never a link or a directory — of at most 32 MiB. A picture that decodes is shown
 * to the agent; any other file, or a picture that does not decode, is named by its path so the
 * agent can open it with its own tools. Nothing here changes or removes a file.
 */
export async function readInboundAttachments(
    attachments: readonly InboundAttachment[],
): Promise<InboundFiles> {
    if (attachments.length > MAX_INBOUND_ATTACHMENTS) {
        throw new InboundAttachmentError(
            `A message may carry at most ${String(MAX_INBOUND_ATTACHMENTS)} attachments.`,
        );
    }
    const images: SessionImageBlock[] = [];
    const notes: string[] = [];
    for (const [index, attachment] of attachments.entries()) {
        const label = `Attachment ${String(index + 1)}`;
        if (!isAbsolute(attachment.path)) {
            throw new InboundAttachmentError(`${label} is not an absolute path.`);
        }
        // No-follow, so a link swapped in after a check cannot be read in its place, and
        // non-blocking, so a named pipe is refused instead of waited on.
        const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
        const file = await open(attachment.path, flags).catch((error: unknown) => {
            throw new InboundAttachmentError(
                (error as NodeJS.ErrnoException).code === "ENOENT"
                    ? `${label} does not exist.`
                    : `${label} is not a regular file that can be read.`,
            );
        });
        try {
            const facts = await file.stat();
            if (!facts.isFile())
                throw new InboundAttachmentError(`${label} is not a regular file.`);
            if (facts.size === 0) throw new InboundAttachmentError(`${label} is empty.`);
            if (facts.size > MAX_INBOUND_ATTACHMENT_BYTES) {
                throw new InboundAttachmentError(`${label} is larger than 32 MiB.`);
            }
            const name = cleanName(attachment.name) ?? basename(attachment.path);
            const mimeType = cleanName(attachment.mimeType) ?? "application/octet-stream";
            if (
                mimeType.startsWith("image/") ||
                IMAGE_EXTENSIONS.has(extname(attachment.path).toLowerCase())
            ) {
                const block = await readImage(file);
                if (block !== undefined) {
                    images.push(block);
                    continue;
                }
            }
            notes.push(
                `(They attached ${JSON.stringify(name)}, ${mimeType}, ${formatSize(facts.size)}, saved at ${attachment.path}.)`,
            );
        } finally {
            await file.close();
        }
    }
    return { images, notes };
}

/** The picture, sized for a model, or undefined when the file does not decode as one. */
async function readImage(file: FileHandle): Promise<SessionImageBlock | undefined> {
    try {
        const prepared = await prepareImageForPrompt(await file.readFile(), {
            maxDimension: MAX_IMAGE_DIMENSION,
            maxPatches: Number.POSITIVE_INFINITY,
        });
        if (prepared.bytes.byteLength > MAX_IMAGE_BYTES) return undefined;
        return {
            type: "image",
            data: prepared.bytes.toString("base64"),
            mimeType: prepared.mediaType,
        };
    } catch (error: unknown) {
        if (error instanceof ImageProcessingError) return undefined;
        throw error;
    }
}

function cleanName(name: string | undefined): string | undefined {
    const cleaned = (name ?? "")
        .replaceAll(/\p{Cc}/gu, "")
        .trim()
        .slice(0, 255);
    return cleaned.length > 0 ? cleaned : undefined;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
