import type { BotSettings } from "../BotSettings.js";

/**
 * What a governed agent is told about the restrictions in force. The daemon enforces every one of
 * them; the text exists so the model plans around them instead of discovering them by failure.
 */
export function formatBotSettingsInstructions(settings: BotSettings): string {
    const lines: string[] = [];
    if (settings.allowedSecretIds !== null) {
        lines.push(
            settings.allowedSecretIds.length === 0
                ? "No secrets are available: you cannot list, attach, create, or select any secret for a command."
                : `Only these secrets are available: ${settings.allowedSecretIds.map((id) => JSON.stringify(id)).join(", ")}. You can list, attach, update, and select only those for a command, and you cannot create secrets.`,
        );
    }
    if (!settings.crossWorkspace) {
        lines.push(
            "You can message, schedule messages for, and read the history of only this bot's own agents. You cannot see or create projects, workspaces, tasks, or other bots, and any subtask you create shares this folder.",
        );
    }
    if (settings.compute.type === "docker") {
        lines.push(
            `Your files and commands run in a Docker container of ${JSON.stringify(settings.compute.image)} with only your own folder mounted. Commands there cannot select secrets.`,
        );
    }
    if (lines.length === 0) return "";
    return [
        "This bot's owner restricts what you and every agent working under it can do. Happy Agent enforces these limits; do not try to work around them, and tell the user when one stops a task.",
        ...lines,
    ].join("\n");
}
