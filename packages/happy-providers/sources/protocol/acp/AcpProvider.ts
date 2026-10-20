import type { Context } from "@steve.kite/stdlib";

import { BaseProvider } from "@/core/BaseProvider.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import type { AcpConnect } from "@/protocol/acp/AcpConnection.js";
import { AcpSession } from "@/protocol/acp/AcpSession.js";

/** How to start the foreign agent: an ACP server speaking NDJSON JSON-RPC over stdio. */
export interface AcpAgentLaunch {
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
}

/** The access the hosting agent currently grants, in Happy's four permission modes. */
export type AcpPermissionMode = "read_only" | "workspace_write" | "auto" | "full_access";

/** Where and under what permission one turn of the foreign agent runs. */
export interface AcpTurnEnvironment {
    readonly cwd: string;
    readonly permissionMode?: AcpPermissionMode;
}

/** One ACP session configuration option to set before a prompt. */
export interface AcpConfigOptionValue {
    readonly configId: string;
    /**
     * The option's ACP category, for an agent that may name it differently: the agent's own
     * option of this category is set instead, and nothing is set when it advertises none.
     */
    readonly category?: string;
    readonly value: string | boolean;
}

/** Files to place in a private directory the foreign agent is given as an extra workspace root. */
export interface AcpBridgeDirectoryFile {
    readonly path: string;
    readonly content: string;
}

/**
 * What differs between foreign agents. ACP fixes the wire; each agent still names its models,
 * maps permission, and discovers MCP servers in its own way.
 */
export interface AcpAgentProfile {
    /** The agent's config-option values for the selected Happy model and effort. */
    readonly modelOptions?: (
        model: string | undefined,
        effort: SessionReasoningEffort | undefined,
    ) => readonly AcpConfigOptionValue[];
    /** The agent's config-option values that best match a Happy permission mode. */
    readonly permissionOptions?: (mode: AcpPermissionMode) => readonly AcpConfigOptionValue[];
    /**
     * For agents that ignore ACP `mcpServers`: files that make the bridge discoverable when the
     * directory holding them is passed as an additional workspace directory.
     */
    readonly bridgeDirectoryFiles?: (bridge: {
        readonly name: string;
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
    }) => readonly AcpBridgeDirectoryFile[];
    /**
     * For agents that bind a new session to whichever native conversation appears next in a
     * shared store: only one new session's first prompt runs at a time, so two cannot swap.
     */
    readonly serializeNewSessions?: boolean;
}

export interface AcpProviderOptions {
    /** The ACP server to start, when the agent is not reached through `connect`. */
    readonly launch?: AcpAgentLaunch;
    /** A first-party driver for the agent; defaults to starting `launch` and speaking ACP. */
    readonly connect?: AcpConnect;
    /** Private directory owned by this provider for session records and bridge files. */
    readonly stateDirectory: string;
    /** The cwd and permission a turn runs under, read from the agent's context. */
    readonly environment: (ctx: Context) => AcpTurnEnvironment;
    readonly profile?: AcpAgentProfile;
}

/**
 * A foreign coding agent driven over the Agent Client Protocol.
 *
 * The agent keeps its own loop, prompts, native tools, and context. Happy keeps its durable
 * transcript, queue, steering, and its own tools, which reach the agent through an MCP bridge
 * and still execute in Agent Base's ordinary tool loop.
 */
export class AcpProvider extends BaseProvider {
    static override readonly name: string = "acp";
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly options: AcpProviderOptions;

    constructor(options: AcpProviderOptions) {
        super();
        this.options = options;
    }

    override async session(id: string, options: SessionOptions): Promise<AcpSession> {
        return new AcpSession(id, {
            ...this.options,
            instructions: options.instructions,
            tools: options.tools ?? [],
        });
    }
}
