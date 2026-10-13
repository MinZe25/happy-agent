import type { ConfigModule } from "../config/index.js";
import type { ExportedBotAdapter } from "./ExportedBotAdapter.js";
import { BridgeAdapter } from "./bridge/BridgeAdapter.js";
import { TelegramAdapter } from "./telegram/TelegramAdapter.js";

/**
 * The kinds of exported bot this daemon offers: Telegram, built in, and bridge, served by any
 * program that speaks the exported-bot protocol. This is the one place a kind is added.
 */
export function createExportedBotAdapters(config: ConfigModule): readonly ExportedBotAdapter[] {
    return [new TelegramAdapter(config), new BridgeAdapter()] as readonly ExportedBotAdapter[];
}
