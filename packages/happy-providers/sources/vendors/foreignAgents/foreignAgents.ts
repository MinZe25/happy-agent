import { acpGenericAgent } from "@/vendors/foreignAgents/acpGenericAgent.js";
import { antigravityAgent } from "@/vendors/foreignAgents/antigravityAgent.js";
import { claudeCodeAgent } from "@/vendors/foreignAgents/claudeCodeAgent.js";
import { codexCliAgent } from "@/vendors/foreignAgents/codexCliAgent.js";
import { opencodeAgent } from "@/vendors/foreignAgents/opencodeAgent.js";
import type { ForeignAgent, ForeignAgentType } from "@/vendors/foreignAgents/ForeignAgent.js";

/** Every built-in foreign agent, by harness type. */
export const FOREIGN_AGENTS: Readonly<Record<Exclude<ForeignAgentType, "acp">, ForeignAgent>> =
    Object.freeze({
        "claude-code": claudeCodeAgent,
        "codex-cli": codexCliAgent,
        antigravity: antigravityAgent,
        opencode: opencodeAgent,
    });

/** The foreign agent behind harness `harness` of type `type`. */
export function foreignAgent(type: ForeignAgentType, harness: string): ForeignAgent {
    return type === "acp" ? acpGenericAgent(harness) : FOREIGN_AGENTS[type];
}
