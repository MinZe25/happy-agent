/**
 * Happy file links: `[Foo.tsx:42](happy-file://agents/<agentId>/packages/app/Foo.tsx#L42)`, an
 * ordinary Markdown link whose destination names the workspace a file lives in, so the link opens
 * the same file wherever the text is read. A bare `path:line` is read against the reader's own
 * workspace instead. This one implementation is shared by the daemon and every client so they agree
 * on exactly what a link names.
 *
 * The URL grammar is strict: a malformed link is never partly interpreted. Surfaces that cannot open
 * links use the Markdown fallback, which replaces each link with its label.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { escapeMarkdownText } from "./happyReferences.js";
import { skipCodeSpan, textBlocks } from "./markdownBlocks.js";

/** The URL scheme. Not `happy`, because the Happy mobile app registers `happy://` for deep links. */
export const HAPPY_FILE_LINK_SCHEME = "happy-file";

/** The longest link URL, in characters. */
export const MAX_HAPPY_FILE_LINK_LENGTH = 4096;

const ID_PATTERN = "^[A-Za-z0-9_-]{1,128}$";
const MAX_LINE = 999_999_999;
// A decoded path segment: never `.` or `..`, and no `/`, `\`, or control character.
const SEGMENT = String.raw`(?!\.\.?(?:/|$))[^/\\\u0000-\u001f\u007f-\u009f]+`;

const lineSchema = Type.Integer({ minimum: 1, maximum: MAX_LINE });

/**
 * One file link. `path` is decoded and relative to the workspace root; `lines` is inclusive, so
 * `#L42` is `{ start: 42, end: 42 }`. An agent target means that agent's workspace.
 */
export const happyFileLinkSchema = Type.Object(
    {
        target: Type.Union([
            Type.Object(
                { type: Type.Literal("agent"), agentId: Type.String({ pattern: ID_PATTERN }) },
                { additionalProperties: false },
            ),
            Type.Object(
                {
                    type: Type.Literal("workspace"),
                    workspaceId: Type.String({ pattern: ID_PATTERN }),
                },
                { additionalProperties: false },
            ),
        ]),
        path: Type.String({
            maxLength: MAX_HAPPY_FILE_LINK_LENGTH,
            pattern: `^${SEGMENT}(?:/${SEGMENT})*$`,
        }),
        lines: Type.Optional(
            Type.Object({ start: lineSchema, end: lineSchema }, { additionalProperties: false }),
        ),
    },
    { additionalProperties: false },
);
export type HappyFileLink = Static<typeof happyFileLinkSchema>;

/** One inline Markdown link to a `happy-file` URL, found by `replaceHappyFileLinks`. */
export interface HappyFileLinkMatch {
    /** The parsed link, or undefined when the URL is malformed. */
    link: HappyFileLink | undefined;
    /** The destination URL, with Markdown backslash escapes removed. */
    url: string;
    /** The Markdown written between the brackets: the link text, or an image's alt text. */
    label: string;
    /** Whether this is an image, `![alt](happy-file://…)`. */
    image: boolean;
    /** The whole link exactly as written. */
    source: string;
}

const LINK = new RegExp(
    String.raw`^happy-file://(agents|workspaces)/([A-Za-z0-9_-]{1,128})/([A-Za-z0-9\-._~!$&'*+,;=:@%/]+)` +
        String.raw`(?:#L([1-9][0-9]{0,8})(?:-L([1-9][0-9]{0,8}))?)?$`,
);
const SCHEME = /^happy-file:/i;
const SCHEME_ANYWHERE = /happy-file:/i;
const ASCII_PUNCTUATION_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** Parses a `happy-file` URL, or returns undefined when it is anything but a well-formed link. */
export function parseHappyFileLink(url: string): HappyFileLink | undefined {
    if (url.length > MAX_HAPPY_FILE_LINK_LENGTH) return undefined;
    const match = LINK.exec(url);
    if (match === null) return undefined;
    const [, kind, id = "", encodedPath = "", start, end] = match;
    const segments: string[] = [];
    for (const segment of encodedPath.split("/")) {
        if (segment === "") return undefined;
        // Also rejects a `%` that starts no escape, and bytes that are not UTF-8.
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            return undefined;
        }
        // An encoded `%2F` is never a separator, and no file name holds a `/`.
        if (decoded.includes("/")) return undefined;
        segments.push(decoded);
    }
    const link: HappyFileLink = {
        target:
            kind === "agents"
                ? { type: "agent", agentId: id }
                : { type: "workspace", workspaceId: id },
        path: segments.join("/"),
    };
    if (start !== undefined) {
        link.lines = { start: Number(start), end: Number(end ?? start) };
    }
    return isValidLink(link) ? link : undefined;
}

/**
 * The canonical URL for a link: every byte of a path segment but the unreserved characters is
 * percent-encoded, and a single line is written `#L42`. Throws a `TypeError` for an invalid link.
 */
export function formatHappyFileLink(link: HappyFileLink): string {
    if (!isValidLink(link)) throw new TypeError("The Happy file link is invalid.");
    const target =
        link.target.type === "agent"
            ? `agents/${link.target.agentId}`
            : `workspaces/${link.target.workspaceId}`;
    let path: string;
    try {
        path = link.path.split("/").map(encodeSegment).join("/");
    } catch {
        // A lone surrogate has no UTF-8 encoding.
        throw new TypeError("The Happy file link is invalid.");
    }
    const lines =
        link.lines === undefined
            ? ""
            : link.lines.start === link.lines.end
              ? `#L${String(link.lines.start)}`
              : `#L${String(link.lines.start)}-L${String(link.lines.end)}`;
    const url = `${HAPPY_FILE_LINK_SCHEME}://${target}/${path}${lines}`;
    if (url.length > MAX_HAPPY_FILE_LINK_LENGTH) {
        throw new TypeError("The Happy file link is too long.");
    }
    return url;
}

/**
 * Replaces every inline Markdown link or image whose destination uses the `happy-file` scheme, in
 * any letter case and whether or not it is well-formed, with `replace`'s text. Links in code spans,
 * fenced code, or behind a backslash-escaped `[` are left alone.
 */
export function replaceHappyFileLinks(
    markdown: string,
    replace: (match: HappyFileLinkMatch) => string,
): string {
    if (!SCHEME_ANYWHERE.test(markdown)) return markdown;
    let output = "";
    let position = 0;
    for (const block of textBlocks(markdown)) {
        let index = block.start;
        while (index < block.end) {
            const character = markdown[index];
            if (character === "\\") {
                index += 2;
            } else if (character === "`") {
                index = skipCodeSpan(markdown, index, block.end, false);
            } else if (character === "[" || (character === "!" && markdown[index + 1] === "[")) {
                const image = character === "!";
                const found = matchInlineLink(markdown, image ? index + 1 : index, block.end);
                if (found === undefined || !SCHEME.test(found.url)) {
                    index += image ? 2 : 1;
                    continue;
                }
                const source = markdown.slice(index, found.end);
                output += markdown.slice(position, index);
                output += replace({
                    link: parseHappyFileLink(found.url),
                    url: found.url,
                    label: found.label,
                    image,
                    source,
                });
                position = found.end;
                index = found.end;
            } else {
                index += 1;
            }
        }
    }
    return output + markdown.slice(position);
}

/**
 * Plain Markdown for surfaces that cannot open file links: each link becomes its label as written.
 * A link with a blank label becomes its decoded path as literal text, or nothing when malformed.
 */
export function renderHappyFileLinksAsText(markdown: string): string {
    return replaceHappyFileLinks(markdown, ({ link, label }) => {
        if (label.trim() !== "") return label;
        return link === undefined ? "" : escapeMarkdownText(link.path);
    });
}

function isValidLink(link: HappyFileLink): boolean {
    return (
        Value.Check(happyFileLinkSchema, link) &&
        (link.lines === undefined || link.lines.end >= link.lines.start)
    );
}

function encodeSegment(segment: string): string {
    return encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/**
 * Matches a CommonMark inline link whose `[` is at `open`: a label with balanced brackets, then
 * `(`, a destination, an optional title, and `)`. Returns the label, the destination with its
 * backslash escapes removed, and the index after the closing parenthesis.
 */
function matchInlineLink(
    markdown: string,
    open: number,
    end: number,
): { label: string; url: string; end: number } | undefined {
    const close = labelEnd(markdown, open, end);
    if (close === undefined || markdown[close + 1] !== "(") return undefined;
    let index = skipWhitespace(markdown, close + 2, end);
    const destination = readDestination(markdown, index, end);
    if (destination === undefined) return undefined;
    index = destination.end;
    const beforeTitle = index;
    index = skipWhitespace(markdown, index, end);
    if (index > beforeTitle) {
        const title = titleEnd(markdown, index, end);
        if (title !== undefined) index = skipWhitespace(markdown, title, end);
    }
    if (markdown[index] !== ")" || index >= end) return undefined;
    return {
        label: markdown.slice(open + 1, close),
        url: destination.url.replace(ASCII_PUNCTUATION_ESCAPE, "$1"),
        end: index + 1,
    };
}

/** The index of the `]` that closes the label opened at `open`. */
function labelEnd(markdown: string, open: number, end: number): number | undefined {
    let depth = 0;
    let index = open + 1;
    while (index < end) {
        const character = markdown[index];
        if (character === "\\") {
            index += 2;
        } else if (character === "`") {
            index = skipCodeSpan(markdown, index, end, false);
        } else if (character === "[") {
            depth += 1;
            index += 1;
        } else if (character === "]") {
            if (depth === 0) return index;
            depth -= 1;
            index += 1;
        } else {
            index += 1;
        }
    }
    return undefined;
}

function readDestination(
    markdown: string,
    start: number,
    end: number,
): { url: string; end: number } | undefined {
    if (markdown[start] === "<") {
        let index = start + 1;
        while (index < end) {
            const character = markdown[index];
            if (character === "\\") index += 2;
            else if (character === ">")
                return { url: markdown.slice(start + 1, index), end: index + 1 };
            else if (character === "<" || character === "\n" || character === "\r")
                return undefined;
            else index += 1;
        }
        return undefined;
    }
    let depth = 0;
    let index = start;
    while (index < end) {
        const character = markdown[index] ?? "";
        if (character === "\\") {
            index += 2;
            continue;
        }
        if (character <= " " || character === "\u007f") break;
        if (character === "(") depth += 1;
        if (character === ")") {
            if (depth === 0) break;
            depth -= 1;
        }
        index += 1;
    }
    if (index === start || depth !== 0) return undefined;
    return { url: markdown.slice(start, Math.min(index, end)), end: Math.min(index, end) };
}

/** The index after a link title quoted with `"`, `'`, or parentheses. */
function titleEnd(markdown: string, start: number, end: number): number | undefined {
    const opening = markdown[start];
    const closing =
        opening === "(" ? ")" : opening === '"' || opening === "'" ? opening : undefined;
    if (closing === undefined) return undefined;
    let index = start + 1;
    while (index < end) {
        const character = markdown[index];
        if (character === "\\") index += 2;
        else if (character === closing) return index + 1;
        else if (opening === "(" && character === "(") return undefined;
        else index += 1;
    }
    return undefined;
}

function skipWhitespace(markdown: string, start: number, end: number): number {
    let index = start;
    while (index < end && /[ \t\r\n]/.test(markdown[index] ?? "")) index += 1;
    return index;
}
