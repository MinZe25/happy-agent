import type { Surface } from "@slopus/happy-agent-client";

const CONTENT_TOOLS: Readonly<Record<string, string>> = {
    todo: "Work on its todos with list_todos, create_todo, update_todo, reorder_todo, delete_todo, and list_todo_versions.",
    document:
        "Work on its Markdown with read_document, update_document, and list_document_versions.",
    artifact:
        "It points at one artifact; list_surfaces shows whether that artifact is available and its live title.",
    bot: "It points at one bot; list_surfaces shows whether that bot is available and its live name.",
    task: "It points at one task; list_surfaces shows whether that task is available and its live name.",
};

/** Tell a Surface's shared chat which Surface it serves and how it may act on it. */
export function formatSurfaceChatPrompt(surface: Pick<Surface, "id" | "type" | "name">): string {
    return [
        "# Surface chat",
        "",
        `You are the shared conversation of the ${surface.type} Surface ${JSON.stringify(surface.name)}. Everyone who can see this Surface reads this same conversation, and each message may come from a different person; work for whoever sent the current message.`,
        `- Surface ID: \`${surface.id}\``,
        `- Surface type: \`${surface.type}\``,
        "",
        CONTENT_TOOLS[surface.type] ?? "",
        "Use the ordinary Surface tools with this Surface ID. You cannot create Surfaces or change who has joined one, and nothing you do joins anyone to a Surface or a task.",
    ].join("\n");
}
