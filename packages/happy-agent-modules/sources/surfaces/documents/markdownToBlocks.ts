import MarkdownIt from "markdown-it";

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];
type Styles = { bold?: true; italic?: true; strike?: true; code?: true };
type StyledText = { type: "text"; text: string; styles: Styles };
type Link = { type: "link"; href: string; content: StyledText[] };
export type MarkdownInline = StyledText | Link;
/** The subset of BlockNote's partial block shape that Markdown can express. */
export type MarkdownBlock = {
    type: string;
    props?: Record<string, unknown>;
    content?:
        | MarkdownInline[]
        | string
        | { type: "tableContent"; headerRows: number; rows: { cells: MarkdownInline[][] }[] };
    children?: MarkdownBlock[];
};

const markdown = new MarkdownIt("commonmark", { html: false }).enable(["table", "strikethrough"]);
const CHECKBOX = /^\[( |x|X)\][ \t]/;

/**
 * Parse Markdown into BlockNote blocks without a DOM. Anything Markdown and the content model do
 * not share degrades to the nearest block: HTML stays literal text and inline images become links.
 */
export function markdownToBlocks(source: string): MarkdownBlock[] {
    const tokens = markdown.parse(source, {});
    let index = 0;
    const blocks = (stop?: string): MarkdownBlock[] => {
        const result: MarkdownBlock[] = [];
        while (index < tokens.length && tokens[index]!.type !== stop) {
            const token = tokens[index]!;
            if (token.type === "heading_open") {
                const level = Math.min(6, Math.max(1, Number(token.tag.slice(1))));
                result.push({
                    type: "heading",
                    props: { level },
                    content: inline(tokens[index + 1]?.children),
                });
                index += 3;
            } else if (token.type === "paragraph_open") {
                const children = tokens[index + 1]?.children ?? [];
                const visible = children.filter((child) => child.type !== "softbreak");
                const image =
                    visible.length === 1 && visible[0]!.type === "image" ? visible[0]! : undefined;
                result.push(
                    image === undefined
                        ? { type: "paragraph", content: inline(children) }
                        : {
                              type: "image",
                              props: {
                                  url: String(image.attrGet("src") ?? ""),
                                  name: image.content,
                                  caption: "",
                              },
                          },
                );
                index += 3;
            } else if (token.type === "fence" || token.type === "code_block") {
                result.push({
                    type: "codeBlock",
                    props: { language: token.info.trim().split(/\s+/)[0] || "text" },
                    content: token.content.replace(/\n$/, ""),
                });
                index += 1;
            } else if (token.type === "hr") {
                result.push({ type: "divider" });
                index += 1;
            } else if (token.type === "blockquote_open") {
                index += 1;
                const inner = blocks("blockquote_close");
                index += 1;
                for (const block of inner)
                    result.push(block.type === "paragraph" ? { ...block, type: "quote" } : block);
            } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
                result.push(...list(token.type === "ordered_list_open"));
            } else if (token.type === "table_open") {
                result.push(table());
            } else index += 1;
        }
        return result;
    };
    const list = (ordered: boolean): MarkdownBlock[] => {
        const close = ordered ? "ordered_list_close" : "bullet_list_close";
        const items: MarkdownBlock[] = [];
        index += 1;
        while (index < tokens.length && tokens[index]!.type !== close) {
            // A list item's first paragraph is its own text; anything after it nests beneath.
            const source = tokens[index + 2]?.type === "inline" ? tokens[index + 2]!.content : "";
            index += 1;
            const [first, ...rest] = blocks("list_item_close");
            index += 1;
            const checkbox = ordered ? null : CHECKBOX.exec(source);
            const content = Array.isArray(first?.content) ? first.content : [];
            const children =
                first === undefined || first.type === "paragraph" ? rest : [first, ...rest];
            items.push(
                checkbox === null
                    ? { type: ordered ? "numberedListItem" : "bulletListItem", content, children }
                    : {
                          type: "checkListItem",
                          props: { checked: checkbox[1] !== " " },
                          content: dropPrefix(content, checkbox[0].length),
                          children,
                      },
            );
        }
        index += 1;
        return items;
    };
    const table = (): MarkdownBlock => {
        const rows: { cells: MarkdownInline[][] }[] = [];
        let row: MarkdownInline[][] | undefined;
        while (index < tokens.length && tokens[index]!.type !== "table_close") {
            const token = tokens[index]!;
            if (token.type === "tr_open") row = [];
            else if (token.type === "inline" && row !== undefined) row.push(inline(token.children));
            else if (token.type === "tr_close" && row !== undefined) rows.push({ cells: row });
            index += 1;
        }
        index += 1;
        return { type: "table", content: { type: "tableContent", headerRows: 1, rows } };
    };
    return blocks();
}

/** Parse one block's inline Markdown into styled text and links. */
export function parseInlineMarkdown(source: string): MarkdownInline[] {
    return inline(markdown.parseInline(source, {})[0]?.children);
}

function inline(tokens: Token[] | null | undefined): MarkdownInline[] {
    const out: MarkdownInline[] = [];
    const styles: Styles = {};
    let link: Link | undefined;
    const push = (text: string, extra: Styles = {}) => {
        if (text === "") return;
        const node: StyledText = { type: "text", text, styles: { ...styles, ...extra } };
        (link === undefined ? out : link.content).push(node);
    };
    for (const token of tokens ?? []) {
        switch (token.type) {
            case "text":
                push(token.content);
                break;
            case "code_inline":
                push(token.content, { code: true });
                break;
            case "softbreak":
                push(" ");
                break;
            case "hardbreak":
                push("\n");
                break;
            case "strong_open":
                styles.bold = true;
                break;
            case "strong_close":
                delete styles.bold;
                break;
            case "em_open":
                styles.italic = true;
                break;
            case "em_close":
                delete styles.italic;
                break;
            case "s_open":
                styles.strike = true;
                break;
            case "s_close":
                delete styles.strike;
                break;
            case "link_open": {
                const opened: Link = {
                    type: "link",
                    href: String(token.attrGet("href") ?? ""),
                    content: [],
                };
                link = opened;
                out.push(opened);
                break;
            }
            case "link_close":
                link = undefined;
                break;
            case "image":
                if (link === undefined)
                    out.push({
                        type: "link",
                        href: String(token.attrGet("src") ?? ""),
                        content: [
                            { type: "text", text: token.content || "image", styles: { ...styles } },
                        ],
                    });
                else push(token.content);
                break;
        }
    }
    return out;
}

/** Remove a parsed checkbox marker from the start of an item's inline content. */
function dropPrefix(content: MarkdownInline[], length: number): MarkdownInline[] {
    let remaining = length;
    const result: MarkdownInline[] = [];
    for (const node of content) {
        if (remaining > 0 && node.type === "text") {
            const cut = Math.min(remaining, node.text.length);
            remaining -= cut;
            if (cut < node.text.length) result.push({ ...node, text: node.text.slice(cut) });
            continue;
        }
        remaining = 0;
        result.push(node);
    }
    return result;
}
