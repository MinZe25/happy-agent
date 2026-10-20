import type { ProviderModelFamily } from "@/core/ProviderModelCompatibility.js";

/** Model ID prefixes of the foreign agents, one per foreign provider type. */
const FOREIGN_AGENT_PREFIXES = ["claude-code/", "codex-cli/", "antigravity/", "opencode/", "acp/"];

export function providerModelFamily(modelId: string): ProviderModelFamily | undefined {
    if (modelId.startsWith("anthropic/")) return "claude";
    if (modelId.startsWith("openai/")) return "codex";
    if (modelId.startsWith("xai/")) return "grok";
    if (modelId.startsWith("moonshotai/")) return "kimi";
    if (modelId.startsWith("zai/")) return "glm";
    if (FOREIGN_AGENT_PREFIXES.some((prefix) => modelId.startsWith(prefix))) return "foreign";
    return undefined;
}
