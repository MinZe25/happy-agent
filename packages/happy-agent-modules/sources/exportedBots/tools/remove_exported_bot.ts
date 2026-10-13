import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    removedExportedBotSchema,
    removeExportedBotInputSchema,
    type RemoveExportedBotInput,
} from "../ExportedBot.js";
import type { ExportedBotsModule } from "../ExportedBotsModule.js";

/** Stop exporting a bot to one chat service. Only active admin bots receive this tool. */
export function removeExportedBotTool(exportedBots: ExportedBotsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "remove_exported_bot",
        defer: true,
        capabilities: [
            "Export bots to Telegram or other chat services and choose who may talk to them.",
        ],
        searchKeywords: ["stop exporting bot", "disconnect Telegram bot", "remove bridge export"],
        description:
            'Stop exporting a bot to a chat service immediately and delete the export\'s stored credentials. kind is how the bot is exported, "telegram" or "bridge"; botId is the exported bot. Existing conversation subtasks and guests stay in Happy. A bridge token stops working and the bridge\'s unsent replies are discarded. To pause instead, use set_telegram_exported_bot or set_bridge_exported_bot with enabled false.',
        parameters: removeExportedBotInputSchema,
        returnType: removedExportedBotSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ kind, botId }: RemoveExportedBotInput) =>
            `stopping the ${JSON.stringify(kind)} export of bot ${botId} and deleting its stored credentials; its conversations stay in Happy`,
        execute: async (ctx, input: RemoveExportedBotInput) =>
            await exportedBots.removeExportedBot(ctx, actingAgentId, input),
        toLLM: ({ removed, service }) => [
            {
                type: "text",
                text: removed
                    ? `Stopped exporting the bot to ${service ?? "the chat service"}. Its credentials are deleted and its conversations stay in Happy.`
                    : "That bot is not exported that way.",
            },
        ],
    });
}
