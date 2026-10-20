import {
    acpSpawnConnect,
    foreignAgentLaunch,
    foreignAgentModelName,
    foreignModelsWithEfforts,
    type ForeignAgent,
} from "@/vendors/foreignAgents/ForeignAgent.js";

/**
 * Any agent with an ACP server, configured as harness `harness` and started from its `command`,
 * `args` and `env`. Its model IDs are `acp/<harness>/<model>`.
 *
 * Nothing about it is known ahead of time: its models are whatever its model selector offers,
 * with efforts when the agent lists them in `_meta`, and its permission is the answer Happy's mode
 * gives to each `session/request_permission`. Happy never compacts ahead of it.
 */
export function acpGenericAgent(harness: string): ForeignAgent {
    const modelPrefix = `acp/${harness}`;
    return {
        type: "acp",
        label: "ACP agent",
        modelPrefix,
        connect: (start) => acpSpawnConnect(foreignAgentLaunch(start, undefined)),
        models: [],
        modelsFromSelector: (values) =>
            foreignModelsWithEfforts(modelPrefix, values, (_value, name) => ({
                name,
                contextWindow: 1_000_000,
            })),
        profile: {
            modelOptions: (selected) => {
                const name = foreignAgentModelName(modelPrefix, selected);
                return name === undefined
                    ? []
                    : [{ configId: "model", category: "model", value: name }];
            },
        },
        credentialEnvironment: () => ({}),
    };
}
