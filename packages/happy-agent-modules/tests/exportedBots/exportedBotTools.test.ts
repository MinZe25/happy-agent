import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import type { ExportedBotsModule } from "../../sources/exportedBots/index.js";
import { setBridgeExportedBotTool } from "../../sources/exportedBots/bridge/set_bridge_exported_bot.js";
import { setTelegramExportedBotTool } from "../../sources/exportedBots/telegram/set_telegram_exported_bot.js";
import type { TelegramAdapter } from "../../sources/exportedBots/telegram/TelegramAdapter.js";
import { approveExportedBotUserTool } from "../../sources/exportedBots/tools/approve_exported_bot_user.js";
import { denyExportedBotUserTool } from "../../sources/exportedBots/tools/deny_exported_bot_user.js";
import { getExportedBotStatusTool } from "../../sources/exportedBots/tools/get_exported_bot_status.js";
import { removeExportedBotTool } from "../../sources/exportedBots/tools/remove_exported_bot.js";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const SECRET = TOKEN.slice(TOKEN.indexOf(":") + 1);
const SCOUT = "scoutbot";

describe("the exported bot tools", () => {
    const ctx = createRootContext();
    const exportedBots = {} as ExportedBotsModule;
    const adapter = {} as TelegramAdapter;

    it("reviews every Telegram export change in Auto without elevating or showing the token", () => {
        const tool = setTelegramExportedBotTool(exportedBots, "chief", adapter);
        const input = { botId: SCOUT, token: TOKEN, allowedUsers: [111, "222"] };

        expect(tool.shouldReviewInAutoMode(input, ctx)).toBe(true);
        expect(tool.requiresAutoOrFullAccess).toBe(true);
        expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(tool.autoPermissionInstructions).toContain("as a guest");
        expect(tool.autoPermissionInstructions).toContain("never authorize anything");
        const action = tool.describeAutoPermissionAction!(input, ctx);
        expect(action).toContain("exporting bot scoutbot to the Telegram bot");
        expect(action).toContain("allowing exactly Telegram user IDs 111, 222");
        expect(action).toContain("to talk to it as guests");
        expect(action).not.toContain(SECRET);
        expect(tool.describeAutoPermissionAction!({ botId: "botid", enabled: false }, ctx)).toBe(
            "changing bot botid's Telegram export; turning the export off",
        );
        expect(
            tool.describeAutoPermissionAction!({ botId: SCOUT, unknownSenders: "ignore" }, ctx),
        ).toContain("ignoring people who are not on the list");
    });

    it("reviews a bridge export and elevates only a token file outside the workspace", async () => {
        const shouldReviewAgentWrite = vi.fn(async (_ctx, _agentId, path: string) =>
            path.startsWith("/outside"),
        );
        const tool = setBridgeExportedBotTool(
            { shouldReviewAgentWrite } as unknown as ExportedBotsModule,
            "chief",
        );
        const input = {
            botId: SCOUT,
            service: "Slack",
            tokenFile: "/outside/slack.token",
            allowedUsers: ["U1"],
        };

        expect(tool.shouldReviewInAutoMode(input, ctx)).toBe(true);
        expect(tool.requiresAutoOrFullAccess).toBe(true);
        expect(await tool.shouldRunInFullAccessInAutoMode!(input, ctx)).toBe(true);
        expect(
            await tool.shouldRunInFullAccessInAutoMode!(
                { botId: SCOUT, tokenFile: "bridge.token" },
                ctx,
            ),
        ).toBe(false);
        expect(
            await tool.shouldRunInFullAccessInAutoMode!({ botId: SCOUT, enabled: false }, ctx),
        ).toBe(false);
        expect(shouldReviewAgentWrite).toHaveBeenCalledWith(ctx, "chief", "/outside/slack.token");
        const action = tool.describeAutoPermissionAction!(input, ctx);
        expect(action).toContain('exporting bot scoutbot through a bridge for "Slack"');
        expect(action).toContain('writing a new bridge token to "/outside/slack.token"');
        expect(action).toContain("can speak to the bot as any allowed guest");
        expect(action).toContain('allowing exactly user IDs "U1"');
    });

    it("reviews approving a person, naming them and the bot, but lets a refusal through", () => {
        const approve = approveExportedBotUserTool(exportedBots, "chief");
        const input = { kind: "telegram", userId: 333, botId: SCOUT };

        expect(approve.shouldReviewInAutoMode(input, ctx)).toBe(true);
        expect(approve.requiresAutoOrFullAccess).toBe(true);
        expect(approve.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(approve.autoPermissionInstructions).toContain("as a guest");
        const action = approve.describeAutoPermissionAction!(input, ctx);
        expect(action).toContain('"telegram" user ID "333"');
        expect(action).toContain("as a guest whose messages never authorize anything");
        expect(action).toContain("talk to bot scoutbot");

        const deny = denyExportedBotUserTool(exportedBots, "chief");
        expect(deny.shouldReviewInAutoMode(input, ctx)).toBe(false);
        expect(deny.requiresAutoOrFullAccess).toBe(true);
    });

    it("reviews a removal and only reads status without review", () => {
        const remove = removeExportedBotTool(exportedBots, "chief");
        const input = { kind: "telegram", botId: SCOUT };
        expect(remove.shouldReviewInAutoMode(input, ctx)).toBe(true);
        expect(remove.requiresAutoOrFullAccess).toBe(true);
        expect(remove.describeAutoPermissionAction!(input, ctx)).toBe(
            'stopping the "telegram" export of bot scoutbot and deleting its stored credentials; its conversations stay in Happy',
        );
        const status = getExportedBotStatusTool(exportedBots, "chief");
        expect(status.shouldReviewInAutoMode({}, ctx)).toBe(false);
        expect(status.requiresAutoOrFullAccess).toBeUndefined();
    });

    it("acts for the bot that holds the tool", async () => {
        const approveUser = vi.fn(async () => ({}));
        const tool = approveExportedBotUserTool(
            { approveUser } as unknown as ExportedBotsModule,
            "chief",
        );
        await tool.execute(ctx, { kind: "bridge", userId: "U1", botId: SCOUT }, {} as never);
        expect(approveUser).toHaveBeenCalledWith(ctx, "chief", {
            kind: "bridge",
            userId: "U1",
            botId: SCOUT,
        });
    });

    it("needs the bot named for every change, and only filters status by it", () => {
        const changes = [
            [setTelegramExportedBotTool(exportedBots, "chief", adapter), { token: TOKEN }],
            [
                setBridgeExportedBotTool(exportedBots, "chief"),
                { service: "Slack", tokenFile: "b.token" },
            ],
            [
                setBridgeExportedBotTool(exportedBots, "chief"),
                { rotateToken: true, tokenFile: "b.token" },
            ],
            [removeExportedBotTool(exportedBots, "chief"), { kind: "bridge" }],
            [approveExportedBotUserTool(exportedBots, "chief"), { kind: "telegram", userId: 333 }],
            [denyExportedBotUserTool(exportedBots, "chief"), { kind: "telegram", userId: 333 }],
        ] as const;
        for (const [tool, input] of changes) {
            const parameters = tool.parameters!;
            expect(Value.Check(parameters, input), tool.name).toBe(false);
            expect(Value.Check(parameters, { ...input, botId: SCOUT }), tool.name).toBe(true);
        }
        const status = getExportedBotStatusTool(exportedBots, "chief").parameters!;
        expect(Value.Check(status, {})).toBe(true);
        expect(Value.Check(status, { botId: SCOUT })).toBe(true);
        expect(Value.Check(status, { botId: "Not A Bot" })).toBe(false);
    });
});
