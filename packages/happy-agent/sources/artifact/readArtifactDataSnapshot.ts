import type { ArtifactDataDump } from "@slopus/happy-agent-modules";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { AgentDaemonError } from "../lifecycle/AgentDaemonError.js";
import { createUnixSocketFetch } from "../lifecycle/createUnixSocketFetch.js";
import { getHappyDaemonPaths } from "../lifecycle/getHappyDaemonPaths.js";
import { readDaemonTokenIfPresent } from "../lifecycle/daemonToken.js";

const changesSchema = Type.Object({
    changes: Type.Array(Type.Unknown()),
    cursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
});
const usersSchema = Type.Object({
    users: Type.Array(
        Type.Object({
            id: Type.String(),
            kind: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
            name: Type.Union([Type.String(), Type.Null()]),
        }),
    ),
});

/** How to reach a daemon: its socket's `fetch` and its token. */
export interface ArtifactDataSnapshotSource {
    readonly fetch: typeof globalThis.fetch;
    readonly token: string;
}

/**
 * Copy one artifact's data out of a daemon, the local one by default, through the same routes
 * its pages use, as a dump the development server loads. It only reads: nothing is written back.
 */
export async function readArtifactDataSnapshot(
    artifactId: string,
    source?: ArtifactDataSnapshotSource,
): Promise<ArtifactDataDump> {
    if (!/^[a-z][a-z0-9]*$/.test(artifactId)) {
        throw new AgentDaemonError(`'${artifactId}' is not an artifact ID.`);
    }
    const { fetch, token } = source ?? (await localDaemon());
    const read = async (path: string): Promise<unknown> => {
        let response: Response;
        try {
            response = await fetch(`http://localhost/v0/artifacts/${artifactId}/api/v1/${path}`, {
                headers: { accept: "application/json", authorization: `Bearer ${token}` },
            });
        } catch {
            throw new AgentDaemonError("Could not reach the Happy Agent daemon.", {
                hint: "Check it with happy-agent status.",
            });
        }
        if (response.status === 404) {
            throw new AgentDaemonError(
                `The daemon has no artifact ${artifactId} with data to copy.`,
            );
        }
        if (!response.ok) {
            throw new AgentDaemonError(
                `The daemon refused to share artifact ${artifactId}'s data (HTTP ${String(response.status)}).`,
            );
        }
        return (await response.json()) as unknown;
    };

    const entries: ArtifactDataDump["entries"][number][] = [];
    let since: string | null = null;
    for (;;) {
        const page = await read(`kv/changes?limit=1000${since === null ? "" : `&since=${since}`}`);
        if (!Value.Check(changesSchema, page)) {
            throw new AgentDaemonError("The daemon answered with data this command cannot read.");
        }
        entries.push(...(page.changes as ArtifactDataDump["entries"]));
        if (!page.hasMore || page.cursor === null) break;
        since = page.cursor;
    }
    const ids = [...new Set(entries.map((entry) => entry.updatedBy))];
    const users: ArtifactDataDump["users"][number][] = [];
    for (let index = 0; index < ids.length; index += 100) {
        const found = await read(`users?ids=${ids.slice(index, index + 100).join(",")}`);
        if (!Value.Check(usersSchema, found)) {
            throw new AgentDaemonError("The daemon answered with people this command cannot read.");
        }
        users.push(
            ...found.users.map((user) => ({ id: user.id, kind: user.kind, name: user.name })),
        );
    }
    return { format: "happy-artifact-data/1", artifactId, entries, users };
}

async function localDaemon(): Promise<ArtifactDataSnapshotSource> {
    const paths = getHappyDaemonPaths();
    const token = await readDaemonTokenIfPresent(paths.tokenPath);
    if (token === undefined) {
        throw new AgentDaemonError(
            "Happy Agent is not running here, so there is nothing to copy.",
            {
                hint: "Start it with happy-agent start, or load a dump with --seed instead.",
            },
        );
    }
    return { fetch: createUnixSocketFetch(paths.socketPath), token };
}
