import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { artifactDataDumpSchema, type ArtifactDataDump } from "@slopus/happy-agent-modules";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { AgentDaemonError } from "../lifecycle/AgentDaemonError.js";
import { readArtifactDataSnapshot } from "./readArtifactDataSnapshot.js";
import { startArtifactDevServer } from "./startArtifactDevServer.js";

export const ARTIFACT_USAGE = `Usage: happy-agent artifact <command>

Commands:
  dev <folder>  Serve an HTML artifact's folder with a local copy of the artifact data API, for
                building and debugging artifact apps without publishing them. Open the page as
                several people with /?as=Name, and control the network, people, data, and debug
                log at /__happy/ (an HTML panel, and JSON routes for scripts).
                --port <port>        Listen here (default 4173; 0 picks a free port).
                --host <address>     Listen on this address (default 127.0.0.1).
                --scratch <folder>   Keep data and the debug log here, kept across restarts.
                                     Without it, a temporary folder is used and removed on exit.
                --from <artifactId>  Start from a copy of that artifact's data in the local
                                     daemon. The copy is never written back.
                --seed <file>        Start from a file: a dump from snapshot or /__happy/data, or
                                     a JSON object of keys and values.
  snapshot <artifactId>  Print a dump of an artifact's data from the local daemon, for --seed.
                --out <file>         Write the dump to a file instead.`;

const valuesSchema = Type.Record(Type.String(), Type.Unknown());

/** `happy-agent artifact ...`: local tools for building artifact apps. */
export async function runArtifactCommand(args: readonly string[]): Promise<void> {
    const [command, ...rest] = args;
    if (command === undefined || command === "--help" || command === "-h") {
        console.log(ARTIFACT_USAGE);
        return;
    }
    if (command === "dev") return await runDev(rest);
    if (command === "snapshot") return await runSnapshot(rest);
    throw new AgentDaemonError(`The artifact command does not have '${command}'.`, {
        hint: "Run happy-agent artifact --help to see its commands.",
    });
}

async function runDev(args: readonly string[]): Promise<void> {
    const { positional, flags } = parse(args, [
        "--port",
        "--host",
        "--scratch",
        "--from",
        "--seed",
    ]);
    if (positional.length !== 1) {
        throw new AgentDaemonError(
            "Name the artifact's folder: happy-agent artifact dev <folder>.",
            {
                hint: "Run happy-agent artifact --help to see every option.",
            },
        );
    }
    const folder = resolve(positional[0] as string);
    if ((await stat(folder).catch(() => undefined))?.isDirectory() !== true) {
        throw new AgentDaemonError(`${folder} is not a folder.`);
    }
    if (flags["--from"] !== undefined && flags["--seed"] !== undefined) {
        throw new AgentDaemonError("Start from --from or --seed, not both.");
    }
    const port = flags["--port"] === undefined ? 4173 : Number(flags["--port"]);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new AgentDaemonError("--port must be a port number.");
    }
    let seed: ArtifactDataDump | { values: Record<string, unknown> } | undefined;
    if (flags["--from"] !== undefined) seed = await readArtifactDataSnapshot(flags["--from"]);
    if (flags["--seed"] !== undefined) seed = await readSeed(resolve(flags["--seed"]));
    const artifactId = seed !== undefined && "format" in seed ? seed.artifactId : "dev";

    const temporary = flags["--scratch"] === undefined;
    const scratch =
        flags["--scratch"] === undefined
            ? await mkdtemp(join(tmpdir(), "happy-artifact-dev-"))
            : resolve(flags["--scratch"]);
    const server = await startArtifactDevServer({
        folder,
        scratch,
        host: flags["--host"] ?? "127.0.0.1",
        port,
        artifactId,
        ...(seed === undefined ? {} : { seed }),
    });
    console.log(`Serving ${folder} at ${server.url}/`);
    console.log(`Controls: ${server.url}/__happy/ · open as someone else: ${server.url}/?as=Alice`);
    console.log(`Data: ${scratch}${temporary ? " (removed on exit)" : ""}`);

    await new Promise<void>((resolveStop) => {
        const stop = () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            resolveStop();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
    await server.close();
    if (temporary) await rm(scratch, { force: true, recursive: true });
}

async function runSnapshot(args: readonly string[]): Promise<void> {
    const { positional, flags } = parse(args, ["--out"]);
    if (positional.length !== 1) {
        throw new AgentDaemonError(
            "Name the artifact: happy-agent artifact snapshot <artifactId>.",
        );
    }
    const dump = await readArtifactDataSnapshot(positional[0] as string);
    const text = `${JSON.stringify(dump, null, 2)}\n`;
    if (flags["--out"] === undefined) {
        process.stdout.write(text);
        return;
    }
    await writeFile(resolve(flags["--out"]), text, { mode: 0o600 });
    console.log(`Wrote ${String(dump.entries.length)} entries to ${resolve(flags["--out"])}.`);
}

async function readSeed(
    path: string,
): Promise<ArtifactDataDump | { values: Record<string, unknown> }> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
        throw new AgentDaemonError(`${path} is not a JSON file.`);
    }
    if (typeof parsed === "object" && parsed !== null && "format" in parsed) {
        if (!Value.Check(artifactDataDumpSchema, parsed)) {
            throw new AgentDaemonError(`${path} is not a dump this version can load.`);
        }
        return parsed;
    }
    if (!Value.Check(valuesSchema, parsed)) {
        throw new AgentDaemonError(`${path} must hold a dump or a JSON object of keys and values.`);
    }
    return { values: parsed };
}

function parse(
    args: readonly string[],
    known: readonly string[],
): { positional: string[]; flags: Partial<Record<string, string>> } {
    const positional: string[] = [];
    const flags: Partial<Record<string, string>> = {};
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index] as string;
        if (!argument.startsWith("--")) {
            positional.push(argument);
            continue;
        }
        if (!known.includes(argument)) {
            throw new AgentDaemonError(`The artifact command does not take ${argument}.`, {
                hint: "Run happy-agent artifact --help to see every option.",
            });
        }
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new AgentDaemonError(`${argument} needs a value.`);
        }
        flags[argument] = value;
        index += 1;
    }
    return { positional, flags };
}
