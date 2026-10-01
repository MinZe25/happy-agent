import { BaseCredential } from "@/core/BaseCredential.js";
import { readClaudeCodeOAuthToken } from "@/vendors/claude/impl/auth.js";

export interface ClaudeCodeCredentialLoadOptions {
    configDir?: string;
    env?: NodeJS.ProcessEnv;
}

export class ClaudeCodeCredential extends BaseCredential<"claude-code", undefined> {
    static async tryLoad(
        options: ClaudeCodeCredentialLoadOptions = {},
    ): Promise<ClaudeCodeCredential | null> {
        const env: NodeJS.ProcessEnv = {
            ...(options.env ?? process.env),
            ...(options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: options.configDir }),
        };
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        // Discovery owns one source. Match its path normalization and do not let the SDK's
        // separate secure-storage override select a different keychain namespace later.
        const configDir = env.CLAUDE_CONFIG_DIR?.trim();
        if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
        else delete env.CLAUDE_CONFIG_DIR;
        delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        if ((await readClaudeCodeOAuthToken({ env })) === undefined) return null;
        return new ClaudeCodeCredential(env.CLAUDE_CONFIG_DIR);
    }

    // Preserve absence as well as a selected directory: setting the default path explicitly
    // changes Claude Code's macOS keychain namespace. Never retain the discovered token.
    readonly configDir?: string;

    private constructor(configDir: string | undefined) {
        super("claude-code", undefined);
        if (configDir !== undefined) this.configDir = configDir;
    }
}
