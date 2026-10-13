import type { AgentModuleMigration, AgentModuleScope } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { botSettingsMigrations, BotSettingsModule } from "../../sources/botSettings/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

/**
 * A tree of agents held in memory: one bot, its subtask, that subtask's collaborator, and an
 * unrelated bot. Bot settings need nothing from the agent collection but ancestry.
 */
export async function governedTree(name: string, migrations: readonly AgentModuleMigration[] = []) {
    const database = moduleDatabase([...botSettingsMigrations, ...migrations], name);
    await database.ready;
    const parents = new Map<string, string | null>([
        ["botagent", null],
        ["subtaskagent", "botagent"],
        ["collaboratoragent", "subtaskagent"],
        ["otherbotagent", null],
        ["otherchild", "otherbotagent"],
    ]);
    const agents = {
        parentOf: async (_ctx: Context, id: string) => parents.get(id) ?? null,
        childOf: async (_ctx: Context, id: string) =>
            [...parents].flatMap(([child, parent]) => (parent === id ? [child] : [])),
    };
    const botSettings = new BotSettingsModule();
    const hooks = botSettings.beforeStart(database.context, agents as never);
    return {
        ctx: database.context,
        database,
        parents,
        agents,
        botSettings,
        hooks,
        scope: (agentId: string) => ({ agent: { id: agentId } }) as unknown as AgentModuleScope,
        close: () => database.close(),
    };
}
