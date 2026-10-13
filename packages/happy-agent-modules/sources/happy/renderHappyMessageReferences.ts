import {
    formatHappyReferenceTag,
    parseHappyReferences,
    renderHappyFileLinksAsText,
    renderHappyReferencesAsMarkdown,
    type HappyReference,
} from "@slopus/happy-agent-client";

import type { HappySessionProtocolMessage } from "./HappyProtocol.js";

/**
 * Replaces the reference tags and file links in what the agent said with plain words, because the
 * phone cannot open them: each tag becomes its entity's current name, or the shared placeholder
 * when `label` has none, and each `happy-file` link becomes its label. Only the agent's own text
 * and service notices carry them; user input and tool output are relayed as they are. Each
 * distinct reference is resolved once, one at a time, so the lookups can share the caller's
 * transaction.
 */
export async function renderHappyMessageReferences(
    messages: readonly HappySessionProtocolMessage[],
    label: (reference: HappyReference) => Promise<string | undefined>,
): Promise<HappySessionProtocolMessage[]> {
    const labels = new Map<string, string | undefined>();
    const rendered: HappySessionProtocolMessage[] = [];
    for (const message of messages) {
        const { content } = message;
        const { ev } = content;
        if (content.role !== "agent" || (ev.t !== "text" && ev.t !== "service")) {
            rendered.push(message);
            continue;
        }
        let text = renderHappyFileLinksAsText(ev.text);
        if (text.includes("<happy-")) {
            let tagged = false;
            for (const segment of parseHappyReferences(text)) {
                if (segment.type !== "reference") continue;
                tagged = true;
                const key = formatHappyReferenceTag(segment.reference);
                if (!labels.has(key)) labels.set(key, await label(segment.reference));
            }
            if (tagged) {
                text = renderHappyReferencesAsMarkdown(text, (reference) =>
                    labels.get(formatHappyReferenceTag(reference)),
                );
            }
        }
        rendered.push(
            text === ev.text
                ? message
                : { ...message, content: { ...content, ev: { ...ev, text } } },
        );
    }
    return rendered;
}
