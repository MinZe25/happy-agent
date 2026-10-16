import { BlockNoteEditor } from "@blocknote/core";
import {
    CommentsExtension,
    DefaultThreadStoreAuth,
    YjsThreadStore,
} from "@blocknote/core/comments";
import * as Y from "yjs";

/**
 * The BlockNote release whose default schema, plus its comment mark, is the document content
 * model. Desktop editors pin the same release; the two move together.
 */
export const BLOCKNOTE_VERSION = "0.51.4";

/** The root `Y.XmlFragment` holding BlockNote blocks. */
export const DOCUMENT_FRAGMENT = "document";
/** The root `Y.Map` holding BlockNote comment threads. */
export const DOCUMENT_THREADS = "threads";

// BlockNote's generic editor types do not compose under exact optional properties.
// oxlint-disable-next-line typescript/no-explicit-any
export type DocumentEditor = BlockNoteEditor<any, any, any>;

let editor: DocumentEditor | undefined;

/**
 * A never-mounted editor: it supplies the exact schema desktop editors bind, comment mark
 * included, and BlockNote's own block conversions. It needs no DOM.
 */
export function documentEditor(): DocumentEditor {
    editor ??= createEditor();
    return editor;
}

function createEditor(): DocumentEditor {
    const threads = new Y.Doc().getMap(DOCUMENT_THREADS);
    return BlockNoteEditor.create({
        extensions: [
            CommentsExtension({
                threadStore: new YjsThreadStore(
                    "happy-agent",
                    threads,
                    new DefaultThreadStoreAuth("happy-agent", "editor"),
                ) as never,
                resolveUsers: async () => [],
            }),
        ],
    });
}
