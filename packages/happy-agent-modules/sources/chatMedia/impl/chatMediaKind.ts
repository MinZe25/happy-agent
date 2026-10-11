import { mediaTypeForPath } from "../../impl/mediaTypeForPath.js";
import {
    MAX_CHAT_MEDIA_FILE_BYTES,
    MAX_CHAT_MEDIA_IMAGE_BYTES,
    MAX_CHAT_MEDIA_VIDEO_BYTES,
} from "../ChatMedia.js";

/** What a file's name says it is, before any byte is read, and how large it may be. */
export interface ChatMediaCandidate {
    readonly kind: "image" | "video" | "document" | "file";
    readonly mimeType: string;
    readonly maxBytes: number;
}

/**
 * Classify a file by its name. An image here is only a candidate: it becomes an image item when
 * its bytes decode, and a plain file otherwise.
 */
export function chatMediaCandidate(name: string): ChatMediaCandidate {
    const mimeType = mediaTypeForPath(name);
    if (mimeType.startsWith("image/")) {
        return { kind: "image", mimeType, maxBytes: MAX_CHAT_MEDIA_IMAGE_BYTES };
    }
    if (mimeType.startsWith("video/")) {
        return { kind: "video", mimeType, maxBytes: MAX_CHAT_MEDIA_VIDEO_BYTES };
    }
    if (mimeType === "application/pdf") {
        return { kind: "document", mimeType, maxBytes: MAX_CHAT_MEDIA_FILE_BYTES };
    }
    return { kind: "file", mimeType, maxBytes: MAX_CHAT_MEDIA_FILE_BYTES };
}

/** A base name fit for display: no control characters, at most 255 characters. */
export function chatMediaName(name: string): string {
    // oxlint-disable-next-line no-control-regex
    const cleaned = name.replaceAll(/[\u0000-\u001f\u007f]/gu, "").trim();
    const bounded = Array.from(cleaned).slice(0, 255).join("");
    return bounded.length === 0 ? "file" : bounded;
}
