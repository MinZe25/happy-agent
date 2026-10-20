import type { ContentBlock } from "@agentclientprotocol/sdk";

import type { SessionMessage, SessionOutputBlock } from "@/core/SessionContext.js";

/**
 * The prompt that carries Happy messages into a foreign agent's next turn.
 *
 * ACP has exactly one input: a user prompt. Everything Happy adds to a conversation — the
 * person's words, system notices, messages from other agents, results of tools the agent no
 * longer has an open call for — is therefore rendered into that prompt, labelled so the foreign
 * model can tell who said what.
 */
export function acpPromptFromMessages(
    messages: readonly SessionMessage[],
    images: boolean,
): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    for (const message of messages) {
        switch (message.role) {
            case "user":
                for (const block of message.content) {
                    if (block.type === "text") blocks.push({ type: "text", text: block.text });
                    else if (block.type === "image") pushImage(blocks, block, images);
                }
                break;
            case "system":
                blocks.push({
                    type: "text",
                    text: `<system-reminder>\n${textOf(message.content)}\n</system-reminder>`,
                });
                break;
            case "agent":
                blocks.push({
                    type: "text",
                    text: `<agent-message from="${message.author.id}" description="${message.author.description}">\n${textOf(message.content)}\n</agent-message>`,
                });
                break;
            case "tool":
                blocks.push({
                    type: "text",
                    text: `<happy-tool-result call="${message.callId}"${message.isError === true ? ' error="true"' : ""}>\n${textOf(message.content)}\n</happy-tool-result>`,
                });
                break;
            case "assistant":
            case "compaction":
                break;
        }
    }
    return mergeText(blocks);
}

/**
 * A fresh foreign session that must continue a conversation it never saw: Happy's instructions
 * and the transcript so far, then the new input.
 */
export function acpReplayPrompt(
    instructions: string,
    history: readonly SessionMessage[],
    pending: readonly SessionMessage[],
    images: boolean,
): ContentBlock[] {
    const preamble: string[] = [];
    if (instructions.trim().length > 0) {
        preamble.push(`<happy-instructions>\n${instructions.trim()}\n</happy-instructions>`);
    }
    const transcript = history.map(transcriptLine).filter((line) => line.length > 0);
    if (transcript.length > 0) {
        preamble.push(
            `<conversation-so-far>\nThis conversation began before this session. Continue it.\n\n${transcript.join("\n\n")}\n</conversation-so-far>`,
        );
    }
    const prompt = acpPromptFromMessages(pending, images);
    if (preamble.length === 0) return prompt;
    return mergeText([{ type: "text", text: preamble.join("\n\n") }, ...prompt]);
}

/**
 * A foreign session resuming after the conversation went on without it — another account,
 * harness or model answered in between: what it missed as a transcript, then the new input.
 */
export function acpCatchUpPrompt(
    missed: readonly SessionMessage[],
    pending: readonly SessionMessage[],
    images: boolean,
): ContentBlock[] {
    const transcript = missed.map(transcriptLine).filter((line) => line.length > 0);
    const prompt = acpPromptFromMessages(pending, images);
    if (transcript.length === 0) return prompt;
    return mergeText([
        {
            type: "text",
            text: `<conversation-elsewhere>\nSince your last turn this conversation continued with another assistant. Continue from where it is now.\n\n${transcript.join("\n\n")}\n</conversation-elsewhere>`,
        },
        ...prompt,
    ]);
}

function transcriptLine(message: SessionMessage): string {
    switch (message.role) {
        case "user":
            return `User: ${textOf(message.content)}`;
        case "system":
            return `System: ${textOf(message.content)}`;
        case "agent":
            return `Agent ${message.author.id}: ${textOf(message.content)}`;
        case "tool":
            return `Tool result (${message.callId}): ${textOf(message.content)}`;
        case "compaction":
            return message.content === null ? "" : `Summary of earlier work: ${message.content}`;
        case "assistant":
            return `Assistant: ${message.content
                .map((block) => {
                    if (block.type === "text") return block.text;
                    if (block.type === "tool_call") {
                        return `[called ${block.name} ${block.arguments}]`;
                    }
                    if (block.type === "tool_result") {
                        return `[result ${textOf(block.content)}]`;
                    }
                    return "";
                })
                .filter((part) => part.length > 0)
                .join("\n")}`;
    }
}

function textOf(blocks: readonly { readonly type: string; readonly text?: string }[]): string {
    return blocks
        .map((block) =>
            block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : "",
        )
        .filter((part) => part.length > 0)
        .join("\n");
}

function pushImage(
    blocks: ContentBlock[],
    block: Extract<SessionOutputBlock, { type: "image" }>,
    images: boolean,
): void {
    if (images) blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else
        blocks.push({
            type: "text",
            text: "[An image was attached but this agent cannot see images.]",
        });
}

/** Adjacent text blocks become one, so the agent sees one coherent message. */
function mergeText(blocks: ContentBlock[]): ContentBlock[] {
    const merged: ContentBlock[] = [];
    for (const block of blocks) {
        const last = merged[merged.length - 1];
        if (block.type === "text" && last?.type === "text") {
            merged[merged.length - 1] = { type: "text", text: `${last.text}\n\n${block.text}` };
        } else {
            merged.push(block);
        }
    }
    return merged;
}
