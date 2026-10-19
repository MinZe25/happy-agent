import { createHash } from "node:crypto";

/** The network of this computer, shared by every agent working here. */
export const HOST_NETWORK_ID = "host";

/** A runner's network is this prefix and the runner's ID. */
export const RUNNER_NETWORK_PREFIX = "r-";

/**
 * The network an agent's machine leaves from, named from the environment the machine was built
 * in: this computer, its runner, or a container of its own. A container's name is derived from
 * the agent, its image, and the machine holding its folder, so it stays the same across restarts
 * and changes with any of them.
 */
export function agentNetworkId(
    agentId: string,
    environment: { readonly runnerId?: string; readonly docker?: { readonly image: string } },
): string {
    if (environment.docker !== undefined) {
        const digest = createHash("sha256")
            .update(
                JSON.stringify([agentId, environment.docker.image, environment.runnerId ?? null]),
            )
            .digest("hex");
        return `c-${digest.slice(0, 32)}`;
    }
    return environment.runnerId === undefined
        ? HOST_NETWORK_ID
        : `${RUNNER_NETWORK_PREFIX}${environment.runnerId}`;
}
