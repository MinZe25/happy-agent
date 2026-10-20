import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";

const require = createRequire(import.meta.url);

/** The release Happy is tested against, fetched with `npx` only when nothing else is installed. */
export const CODEX_PINNED_VERSION = "0.160.1";

const TARGETS: Readonly<Record<string, readonly [triple: string, platformPackage: string]>> = {
    "darwin-arm64": ["aarch64-apple-darwin", "@openai/codex-darwin-arm64"],
    "darwin-x64": ["x86_64-apple-darwin", "@openai/codex-darwin-x64"],
    "linux-arm64": ["aarch64-unknown-linux-musl", "@openai/codex-linux-arm64"],
    "linux-x64": ["x86_64-unknown-linux-musl", "@openai/codex-linux-x64"],
    "win32-arm64": ["aarch64-pc-windows-msvc", "@openai/codex-win32-arm64"],
    "win32-x64": ["x86_64-pc-windows-msvc", "@openai/codex-win32-x64"],
};

/**
 * How to start `codex app-server`: the pinned release installed with this package, then a `codex`
 * on PATH, then the pinned release through `npx`. The pinned binary is started directly with its
 * bundled tools on PATH, as Codex's own launcher does.
 */
export function codexAppServerLaunch(env: NodeJS.ProcessEnv = {}): AcpAgentLaunch {
    const pinned = pinnedCodexExecutable();
    if (pinned !== undefined) {
        const tools = join(dirname(dirname(pinned)), "codex-path");
        const path = env["PATH"] ?? process.env["PATH"] ?? "";
        return {
            command: pinned,
            args: ["app-server"],
            env: existsSync(tools) ? { ...env, PATH: `${tools}${delimiter}${path}` } : env,
        };
    }
    if (onPath("codex", env)) return { command: "codex", args: ["app-server"], env };
    return {
        command: "npx",
        args: ["-y", `@openai/codex@${CODEX_PINNED_VERSION}`, "app-server"],
        env,
    };
}

function pinnedCodexExecutable(): string | undefined {
    const target = TARGETS[`${process.platform}-${process.arch}`];
    if (target === undefined) return undefined;
    const [triple, platformPackage] = target;
    try {
        const codex = createRequire(require.resolve("@openai/codex/package.json"));
        const root = dirname(codex.resolve(`${platformPackage}/package.json`));
        const executable = join(
            root,
            "vendor",
            triple,
            "bin",
            process.platform === "win32" ? "codex.exe" : "codex",
        );
        return existsSync(executable) ? executable : undefined;
    } catch {
        return undefined;
    }
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
    const path = env["PATH"] ?? process.env["PATH"] ?? "";
    const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`] : [command];
    return path
        .split(delimiter)
        .some(
            (directory) =>
                directory !== "" && names.some((name) => existsSync(join(directory, name))),
        );
}
