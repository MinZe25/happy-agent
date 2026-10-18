import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { agentDocumentChange } from "../../../sources/surfaces/documents/agentDocumentChange.js";
import {
    DOCUMENT_FRAGMENT,
    documentEditor,
} from "../../../sources/surfaces/documents/documentEditor.js";
import {
    markdownToUpdate,
    readDocument,
} from "../../../sources/surfaces/documents/readDocument.js";

type Block = {
    id: string;
    type: string;
    props: Record<string, unknown>;
    content: unknown;
    children: Block[];
};

const load = (state: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
};
const blocksOf = (doc: Y.Doc) =>
    yXmlFragmentToBlocks(
        documentEditor(),
        doc.getXmlFragment(DOCUMENT_FRAGMENT),
    ) as unknown as Block[];
const texts = (doc: Y.Doc) => {
    const out: Y.XmlText[] = [];
    const walk = (node: Y.XmlFragment | Y.XmlElement) =>
        node
            .toArray()
            .forEach((child) =>
                child instanceof Y.XmlText ? out.push(child) : walk(child as Y.XmlElement),
            );
    walk(doc.getXmlFragment(DOCUMENT_FRAGMENT));
    return out;
};
const plain = (text: Y.XmlText) =>
    (text.toDelta() as { insert: unknown }[])
        .map((op) => (typeof op.insert === "string" ? op.insert : ""))
        .join("");
const find = (doc: Y.Doc, value: string) =>
    texts(doc).find((text) => plain(text).startsWith(value))!;

/** What the agent would write: the version it read, as Markdown, edited. */
function agentEdit(state: Uint8Array, edit: (markdown: string) => string): Uint8Array | undefined {
    const reading = readDocument(state);
    return agentDocumentChange(load(state), reading.root, edit(reading.text));
}

function fromBlocks(blocks: unknown[]): Uint8Array {
    const doc = new Y.Doc();
    blocksToYXmlFragment(documentEditor(), blocks as never, doc.getXmlFragment(DOCUMENT_FRAGMENT));
    return Y.encodeStateAsUpdate(doc);
}
const paragraph = (
    text: string,
    props: Record<string, unknown> = {},
    children: unknown[] = [],
) => ({
    type: "paragraph",
    props,
    content: text === "" ? [] : [{ type: "text", text, styles: {} }],
    children,
});

describe("agent document changes", () => {
    it("merges with concurrent typing and keeps comments on unchanged text", () => {
        const seed = load(
            markdownToUpdate(
                "# Plan\n\nIntro text.\n\n- First item\n- Second item\n\nClosing paragraph.\n",
            )!,
        );
        seed.transact(() => {
            find(seed, "Closing").format(0, 7, { comment: { threadId: "kept", orphan: false } });
            find(seed, "Second item").format(0, 6, {
                comment: { threadId: "edited", orphan: false },
            });
        });
        const base = Y.encodeStateAsUpdate(seed);
        const person = load(base);
        const vector = Y.encodeStateVector(person);
        person.transact(() => {
            find(person, "Second item").insert(0, "Very ");
            const intro = find(person, "Intro text.");
            intro.insert(intro.length, " Typed meanwhile.");
        });
        const typed = Y.encodeStateAsUpdate(person, vector);
        const agent = agentEdit(base, (markdown) =>
            markdown
                .replace("# Plan", "# Plan (revised)")
                .replace("Second item", "Second item, clarified")
                .concat("\nAgent paragraph.\n"),
        )!;
        for (const order of [
            [typed, agent],
            [agent, typed],
        ]) {
            const doc = load(base);
            for (const update of order) Y.applyUpdate(doc, update);
            const { text } = readDocument(Y.encodeStateAsUpdate(doc));
            expect(text).toContain("# Plan (revised)");
            expect(text).toContain("Intro text. Typed meanwhile.");
            expect(text).toContain("- Very Second item, clarified");
            expect(text).toContain("Agent paragraph.");
            const comments = JSON.stringify(texts(doc).map((text) => text.toDelta()));
            expect(comments).toContain('"kept"');
            expect(comments).toContain('"edited"');
        }
    });

    it("changes nothing when the Markdown is what the agent read", () => {
        const state = markdownToUpdate(
            "# Title\n\nSome a_snake_name text with **bold**.\n\n1. One\n2. Two\n",
        )!;
        expect(agentEdit(state, (markdown) => markdown)).toBeUndefined();
    });

    it("keeps untouched blocks, nesting Markdown cannot show, empty blocks, and edited block identity", () => {
        const state = fromBlocks([
            paragraph("Parent", {}, [paragraph("Nested child")]),
            paragraph(""),
            paragraph("Colored", { textColor: "red" }),
            paragraph("Last"),
        ]);
        const before = blocksOf(load(state));
        const change = agentEdit(state, (markdown) =>
            markdown.replace("Colored", "Colored and edited"),
        )!;
        const doc = load(state);
        Y.applyUpdate(doc, change);
        const after = blocksOf(doc);
        expect(after.map((block) => block.id)).toEqual(before.map((block) => block.id));
        expect(after[0]!.children.map((block) => block.id)).toEqual(
            before[0]!.children.map((block) => block.id),
        );
        expect(after[1]!.content).toEqual([]);
        expect(after[2]!.props["textColor"]).toBe("red");
        expect(readDocument(Y.encodeStateAsUpdate(doc)).text).toContain("Colored and edited");
    });

    it("clears to one empty block and history-free reads stay valid", () => {
        const state = markdownToUpdate("# Title\n\nBody\n")!;
        const doc = load(state);
        Y.applyUpdate(doc, agentEdit(state, () => "")!);
        const blocks = blocksOf(doc);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ type: "paragraph", content: [] });
        expect(readDocument(Y.encodeStateAsUpdate(doc)).outsideModel).toBe(false);
    });

    it("writes into an empty document from version 0", () => {
        const empty = Y.encodeStateAsUpdate(new Y.Doc());
        const change = agentEdit(empty, () => "# Fresh\n\n- [ ] task\n")!;
        expect(readDocument(change).text).toBe("# Fresh\n\n- [ ] task\n");
    });
});
