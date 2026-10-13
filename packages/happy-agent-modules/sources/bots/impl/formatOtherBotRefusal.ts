import type { BotRecord } from "../Bot.js";

/**
 * Why a bot that is not an admin may not change another bot, naming the admin bots that may, as
 * `create_bot` does, so the model knows whom to ask.
 */
export function formatOtherBotRefusal(
    action: string,
    ownAction: string,
    bots: readonly BotRecord[],
): string {
    const admins = bots.filter((bot) => bot.isAdmin);
    const refusal = `Only an admin bot can ${action}.`;
    const own = `Omit botId, or pass your own bot ID, to ${ownAction}.`;
    if (admins.length === 0) {
        return `${refusal} There are no admin bots on this installation. ${own}`;
    }
    return [
        `${refusal} ${own} Admin bots on this installation:`,
        ...admins.map(
            (bot) =>
                `- ${bot.name}${bot.status === "archived" ? " (archived)" : ""} — id ${bot.id}`,
        ),
    ].join("\n");
}
