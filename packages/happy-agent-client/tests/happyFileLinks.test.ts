import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    formatHappyFileLink,
    HAPPY_FILE_LINK_SCHEME,
    happyFileLinkSchema,
    MAX_HAPPY_FILE_LINK_LENGTH,
    parseHappyFileLink,
    renderHappyFileLinksAsText,
    replaceHappyFileLinks,
    type HappyFileLink,
} from "../sources/index.js";

const AGENT = "a1b2c3d4";
const WORKSPACE = "k2h4j5l6";

describe("parseHappyFileLink", () => {
    it("parses both targets, with and without lines", () => {
        expect(
            parseHappyFileLink(`happy-file://agents/${AGENT}/packages/app/Foo.tsx#L42-L50`),
        ).toEqual({
            target: { type: "agent", agentId: AGENT },
            path: "packages/app/Foo.tsx",
            lines: { start: 42, end: 50 },
        });
        expect(parseHappyFileLink(`happy-file://workspaces/${WORKSPACE}/README.md`)).toEqual({
            target: { type: "workspace", workspaceId: WORKSPACE },
            path: "README.md",
        });
        expect(parseHappyFileLink(`happy-file://agents/${AGENT}/a.ts#L7`)?.lines).toEqual({
            start: 7,
            end: 7,
        });
        expect(parseHappyFileLink(`happy-file://agents/${AGENT}/a.ts#L7-L7`)?.lines).toEqual({
            start: 7,
            end: 7,
        });
    });

    it("decodes each segment as UTF-8, in either hex case", () => {
        expect(
            parseHappyFileLink(`happy-file://agents/${AGENT}/docs/R%C3%A9sum%c3%a9%20%281%29.md`)
                ?.path,
        ).toBe("docs/Résumé (1).md");
        expect(parseHappyFileLink(`happy-file://agents/${AGENT}/a:b@c!$&'*+,;=~.ts`)?.path).toBe(
            "a:b@c!$&'*+,;=~.ts",
        );
        expect(parseHappyFileLink(`happy-file://agents/${AGENT}/%2E%2E.ts`)?.path).toBe("...ts");
        expect(parseHappyFileLink(`happy-file://agents/${AGENT}/.env`)?.path).toBe(".env");
    });

    it.each([
        ["another scheme", `happy://agents/${AGENT}/a.ts`],
        ["an uppercase scheme", `HAPPY-FILE://agents/${AGENT}/a.ts`],
        ["a singular target", `happy-file://agent/${AGENT}/a.ts`],
        ["an unknown target", `happy-file://projects/${AGENT}/a.ts`],
        ["an empty id", "happy-file://agents//a.ts"],
        ["a long id", `happy-file://agents/${"a".repeat(129)}/a.ts`],
        ["an id with a dot", "happy-file://agents/a.b/a.ts"],
        ["no path", `happy-file://agents/${AGENT}`],
        ["an empty path", `happy-file://agents/${AGENT}/`],
        ["a leading slash", `happy-file://agents/${AGENT}//a.ts`],
        ["a trailing slash", `happy-file://agents/${AGENT}/src/`],
        ["an empty segment", `happy-file://agents/${AGENT}/src//a.ts`],
        ["a dot segment", `happy-file://agents/${AGENT}/./a.ts`],
        ["a parent segment", `happy-file://agents/${AGENT}/src/../a.ts`],
        ["an encoded parent segment", `happy-file://agents/${AGENT}/%2e%2E/a.ts`],
        ["an encoded slash", `happy-file://agents/${AGENT}/src%2Fa.ts`],
        ["an encoded backslash", `happy-file://agents/${AGENT}/src%5Ca.ts`],
        ["an encoded control character", `happy-file://agents/${AGENT}/a%0A.ts`],
        ["an encoded C1 control character", `happy-file://agents/${AGENT}/a%C2%85.ts`],
        ["an encoded NUL", `happy-file://agents/${AGENT}/a%00.ts`],
        ["a stray percent", `happy-file://agents/${AGENT}/100%.ts`],
        ["a short escape", `happy-file://agents/${AGENT}/a%4.ts`],
        ["invalid UTF-8", `happy-file://agents/${AGENT}/a%C3.ts`],
        ["an encoded surrogate", `happy-file://agents/${AGENT}/a%ED%A0%80.ts`],
        ["a raw space", `happy-file://agents/${AGENT}/a b.ts`],
        ["raw parentheses", `happy-file://agents/${AGENT}/a(1).ts`],
        ["a raw non-ASCII character", `happy-file://agents/${AGENT}/é.ts`],
        ["a raw backslash", `happy-file://agents/${AGENT}/a\\b.ts`],
        ["a query", `happy-file://agents/${AGENT}/a.ts?raw=1`],
        ["an empty fragment", `happy-file://agents/${AGENT}/a.ts#`],
        ["a lowercase line marker", `happy-file://agents/${AGENT}/a.ts#l4`],
        ["a line zero", `happy-file://agents/${AGENT}/a.ts#L0`],
        ["a leading zero", `happy-file://agents/${AGENT}/a.ts#L04`],
        ["ten digits", `happy-file://agents/${AGENT}/a.ts#L1000000000`],
        ["an end before the start", `happy-file://agents/${AGENT}/a.ts#L9-L4`],
        ["a range without the second L", `happy-file://agents/${AGENT}/a.ts#L4-9`],
        ["a column", `happy-file://agents/${AGENT}/a.ts#L4C2`],
        ["another fragment", `happy-file://agents/${AGENT}/a.ts#readme`],
        ["two fragments", `happy-file://agents/${AGENT}/a.ts#L1#L2`],
        ["surrounding space", ` happy-file://agents/${AGENT}/a.ts`],
    ])("rejects %s", (_name, url) => {
        expect(parseHappyFileLink(url)).toBeUndefined();
    });

    it("bounds the whole link", () => {
        const prefix = `happy-file://agents/${AGENT}/`;
        const longest = `${prefix}${"a".repeat(MAX_HAPPY_FILE_LINK_LENGTH - prefix.length)}`;
        expect(parseHappyFileLink(longest)?.path).toHaveLength(longest.length - prefix.length);
        expect(parseHappyFileLink(`${longest}a`)).toBeUndefined();
    });
});

describe("formatHappyFileLink", () => {
    it("writes the canonical link that parses back to the same value", () => {
        const links: [HappyFileLink, string][] = [
            [
                {
                    target: { type: "agent", agentId: AGENT },
                    path: "packages/app/Foo.tsx",
                    lines: { start: 42, end: 50 },
                },
                `happy-file://agents/${AGENT}/packages/app/Foo.tsx#L42-L50`,
            ],
            [
                {
                    target: { type: "workspace", workspaceId: WORKSPACE },
                    path: "README.md",
                    lines: { start: 3, end: 3 },
                },
                `happy-file://workspaces/${WORKSPACE}/README.md#L3`,
            ],
            [
                { target: { type: "agent", agentId: AGENT }, path: "docs/Résumé (1) [old]:#?%.md" },
                `happy-file://agents/${AGENT}/docs/R%C3%A9sum%C3%A9%20%281%29%20%5Bold%5D%3A%23%3F%25.md`,
            ],
            [
                { target: { type: "agent", agentId: AGENT }, path: "it's*!~_-.ts" },
                `happy-file://agents/${AGENT}/it%27s%2A%21~_-.ts`,
            ],
        ];
        for (const [link, url] of links) {
            expect(formatHappyFileLink(link)).toBe(url);
            expect(parseHappyFileLink(url)).toEqual(link);
            expect(Value.Check(happyFileLinkSchema, link)).toBe(true);
        }
        expect(formatHappyFileLink(links[0]![0]).startsWith(`${HAPPY_FILE_LINK_SCHEME}://`)).toBe(
            true,
        );
    });

    it.each([
        ["an absolute path", { target: { type: "agent", agentId: AGENT }, path: "/etc/hosts" }],
        ["an empty path", { target: { type: "agent", agentId: AGENT }, path: "" }],
        ["a parent segment", { target: { type: "agent", agentId: AGENT }, path: "a/../b" }],
        ["a dot segment", { target: { type: "agent", agentId: AGENT }, path: "./b" }],
        ["a backslash", { target: { type: "agent", agentId: AGENT }, path: "a\\b" }],
        ["a newline", { target: { type: "agent", agentId: AGENT }, path: "a\nb" }],
        ["a lone surrogate", { target: { type: "agent", agentId: AGENT }, path: "a\ud800" }],
        ["a bad id", { target: { type: "agent", agentId: "a/b" }, path: "a" }],
        [
            "a reversed range",
            { target: { type: "agent", agentId: AGENT }, path: "a", lines: { start: 2, end: 1 } },
        ],
        [
            "line zero",
            { target: { type: "agent", agentId: AGENT }, path: "a", lines: { start: 0, end: 1 } },
        ],
        [
            "a fractional line",
            { target: { type: "agent", agentId: AGENT }, path: "a", lines: { start: 1.5, end: 2 } },
        ],
        ["an unknown target", { target: { type: "project", projectId: AGENT }, path: "a" }],
        ["an extra field", { target: { type: "agent", agentId: AGENT }, path: "a", title: "x" }],
        [
            "a path too long once encoded",
            { target: { type: "agent", agentId: AGENT }, path: "é".repeat(1000) },
        ],
    ])("refuses %s", (_name, link) => {
        expect(() => formatHappyFileLink(link as HappyFileLink)).toThrow(TypeError);
    });
});

describe("renderHappyFileLinksAsText", () => {
    const url = `happy-file://agents/${AGENT}/packages/app/Foo.tsx#L42`;

    it("replaces each link and image with its label as written", () => {
        expect(
            renderHappyFileLinksAsText(
                `See [Foo.tsx:42](${url}), [**bold** \`a]b\` [x]](${url}) and ![diagram](${url}).`,
            ),
        ).toBe("See Foo.tsx:42, **bold** `a]b` [x] and diagram.");
    });

    it("accepts every inline link form, and malformed or differently cased destinations", () => {
        expect(
            renderHappyFileLinksAsText(
                [
                    `[angle](<${url}>)`,
                    `[title]( ${url} "Foo" )`,
                    `[single](${url} 'Foo')`,
                    `[paren](${url} (Foo))`,
                    `[broken](happy-file://agents/${AGENT}/../a.ts)`,
                    `[parens](happy-file://agents/${AGENT}/a(1).ts)`,
                    `[cased](HAPPY-FILE://agents/${AGENT}/a.ts)`,
                    `[next line](\n${url})`,
                ].join("\n"),
            ),
        ).toBe(
            ["angle", "title", "single", "paren", "broken", "parens", "cased", "next line"].join(
                "\n",
            ),
        );
    });

    it("uses the decoded path for a blank label, and drops a blank malformed link", () => {
        expect(
            renderHappyFileLinksAsText(
                `[](happy-file://agents/${AGENT}/my_file%20*1*.md) [ ](happy-file://agents/${AGENT}/..)!`,
            ),
        ).toBe("my\\_file \\*1\\*.md !");
    });

    it("leaves code, escapes, other links, and incomplete links alone", () => {
        const untouched = [
            `\`[Foo](${url})\``,
            `\\[Foo](${url})`,
            `[Foo]\\(${url})`,
            `[docs](https://example.com/a.ts)`,
            `[Foo](${url}`,
            `[Foo] (${url})`,
            `[Foo](${url} "unterminated)`,
            `<${url}>`,
            url,
            "",
            "```",
            `[Foo](${url})`,
            "```",
            "",
            `[Foo\n\n](${url})`,
        ].join("\n");
        expect(renderHappyFileLinksAsText(untouched)).toBe(untouched);
    });

    it("finds a link inside the label of an ordinary one", () => {
        expect(renderHappyFileLinksAsText(`[see [Foo](${url})](https://example.com)`)).toBe(
            "[see Foo](https://example.com)",
        );
    });
});

describe("replaceHappyFileLinks", () => {
    it("reports each link's parts and keeps the text around it", () => {
        const seen: unknown[] = [];
        const text = replaceHappyFileLinks(
            `a ![x](happy-file://workspaces/${WORKSPACE}/b%5C.ts "t") b [y](<happy-file://workspaces/${WORKSPACE}/c\\_d.ts>) c`,
            (match) => {
                seen.push(match);
                return "@";
            },
        );
        expect(text).toBe("a @ b @ c");
        expect(seen).toEqual([
            {
                link: undefined,
                url: `happy-file://workspaces/${WORKSPACE}/b%5C.ts`,
                label: "x",
                image: true,
                source: `![x](happy-file://workspaces/${WORKSPACE}/b%5C.ts "t")`,
            },
            {
                link: { target: { type: "workspace", workspaceId: WORKSPACE }, path: "c_d.ts" },
                url: `happy-file://workspaces/${WORKSPACE}/c_d.ts`,
                label: "y",
                image: false,
                source: `[y](<happy-file://workspaces/${WORKSPACE}/c\\_d.ts>)`,
            },
        ]);
    });
});
