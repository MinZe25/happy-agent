import {
    acpSpawnConnect,
    foreignAgentLaunch,
    foreignAgentModelName,
    foreignModelsWithEfforts,
    type ForeignAgent,
} from "@/vendors/foreignAgents/ForeignAgent.js";

/**
 * OpenCode through its own ACP server, `opencode acp`, signed in with its own providers. Its
 * models are whatever those providers serve (`openai/gpt-5.5`, …), so there is no curated list;
 * Happy's read-only mode is OpenCode's `plan` mode and every other mode is `build`.
 */
export const opencodeAgent: ForeignAgent = {
    type: "opencode",
    label: "OpenCode",
    modelPrefix: "opencode",
    connect: (start) =>
        acpSpawnConnect(foreignAgentLaunch(start, { command: "opencode", args: ["acp"] })),
    models: [],
    modelsFromSelector: (values) =>
        foreignModelsWithEfforts("opencode", values, (_value, name) => ({
            name: `OpenCode · ${name}`,
            contextWindow: 400_000,
        })),
    profile: {
        modelOptions: (selected) => {
            const name = foreignAgentModelName("opencode", selected);
            return name === undefined ? [] : [{ configId: "model", value: name }];
        },
        permissionOptions: (mode) => [
            { configId: "mode", value: mode === "read_only" ? "plan" : "build" },
        ],
    },
    credentialEnvironment: (credentials) =>
        credentials.apiKey === undefined ? {} : { OPENAI_API_KEY: credentials.apiKey },
};
