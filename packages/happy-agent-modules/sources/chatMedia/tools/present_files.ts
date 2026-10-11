import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import {
    chatMediaPresentationSchema,
    MAX_CHAT_MEDIA_ITEMS,
    type ChatMediaItem,
} from "../ChatMedia.js";
import type { ChatMediaModule } from "../ChatMediaModule.js";

const presentFilesArgumentsSchema = Type.Object(
    {
        filepaths: Type.Array(
            Type.String({
                minLength: 1,
                maxLength: 4096,
                description:
                    "A file on your machine, absolute or relative to your working directory",
            }),
            {
                minItems: 1,
                maxItems: MAX_CHAT_MEDIA_ITEMS,
                description: "The files to show, in the order the user should see them",
            },
        ),
    },
    { additionalProperties: false },
);

const presentFilesResultSchema = Type.Object(
    { presentation: chatMediaPresentationSchema },
    { additionalProperties: false },
);

/** Show files from the agent's machine to the user, inline in this chat. */
export function presentFilesTool(
    chatMedia: ChatMediaModule,
    compute: ComputeModule,
    agentId: string,
) {
    return defineAgentTool({
        name: "present_files",
        defer: true,
        capabilities: ["Show files, documents, images, and videos to the user inline in the chat."],
        searchKeywords: ["show file", "present image", "share video", "display pdf", "send file"],
        description: `Show files from your machine to the user, inline in this chat: images appear as pictures, videos as players, PDFs as documents, and any other file as a file the user can open or download.

Use it when the user should see or receive a file you made or found, such as a chart, a screenshot, a rendered video, a PDF report, or an exported spreadsheet. Generated images and artifacts are already shown when you make them, so do not present them again in the same chat.

The files are copied when you call this, so later changes to them do not change what the user sees. An image may be at most 32 MiB, a video 256 MiB, and a document or other file 64 MiB, with at most 256 MiB per call.`,
        parameters: presentFilesArgumentsSchema,
        returnType: presentFilesResultSchema,
        // A repeated call reads the same files again and shows the same items.
        durable: true,
        shouldReviewInAutoMode: ({ filepaths }, ctx) =>
            shouldReviewPaths(ctx, compute, agentId, filepaths),
        shouldRunInFullAccessInAutoMode: ({ filepaths }, ctx) =>
            shouldReviewPaths(ctx, compute, agentId, filepaths),
        describeAutoPermissionAction: ({ filepaths }) =>
            `showing ${filepaths.map(quoteVisibleExact).join(", ")} from this machine to the user in this chat. Access: local file read (outside-workspace or symlink targets require full access) and a copy into this installation's private chat media`,
        execute: async (ctx, { filepaths }) => {
            const { items } = await chatMedia.presentFiles(ctx, agentId, filepaths);
            return { presentation: chatMedia.presentation(items) };
        },
        toLLM: ({ presentation: { items } }) => [
            {
                type: "text",
                text: [
                    `Presented ${String(items.length)} ${items.length === 1 ? "file" : "files"} to the user in this chat: ${items.map(describeItem).join(", ")}.`,
                    "The user sees them inline now, so do not repeat their paths or describe them as if the user cannot see them.",
                    "They appear only in this chat's history, not in any parent or child chat; if a user should see them in another chat, the agent in that chat must present them there.",
                ].join(" "),
            },
        ],
    });
}

/** Whether reading any of these files crosses the agent's filesystem boundary. */
async function shouldReviewPaths(
    ctx: Context,
    computeModule: ComputeModule,
    agentId: string,
    paths: readonly string[],
): Promise<boolean> {
    const compute = await computeModule.resolve(ctx, agentId);
    if (compute === undefined) return false;
    for (const path of paths) {
        if (await computeModule.shouldReviewPath(ctx, compute, path, { write: false })) return true;
    }
    return false;
}

function describeItem(item: ChatMediaItem): string {
    const size = formatSize(item.size);
    return item.kind === "image"
        ? `${JSON.stringify(item.name)} (image, ${String(item.width)}×${String(item.height)}, ${size})`
        : `${JSON.stringify(item.name)} (${item.kind}, ${item.mimeType}, ${size})`;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
