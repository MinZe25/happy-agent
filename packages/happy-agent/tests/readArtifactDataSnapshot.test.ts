import { describe, expect, it } from "vitest";

import { AgentDaemonError, readArtifactDataSnapshot } from "../sources/index.js";

function entry(key: string, index: number) {
    return {
        key,
        value: index,
        deleted: false,
        version: `01991f3a-5c1e-7000-8000-${String(index).padStart(12, "0")}`,
        updatedBy: index % 2 === 0 ? "uann" : "abot",
        updatedAt: 1_755_400_000_000 + index,
        writeId: null,
    };
}

describe("copying an artifact's data from a daemon", () => {
    it("reads every change page and the authors' names, and never writes", async () => {
        const all = Array.from({ length: 1_500 }, (_, index) => entry(`k${String(index)}`, index));
        const requests: string[] = [];
        const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
            const url = new URL(String(input));
            requests.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
            expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
            if (url.pathname.endsWith("/kv/changes")) {
                const since = url.searchParams.get("since");
                const start = since === null ? 0 : all.findIndex((e) => e.version === since) + 1;
                const changes = all.slice(start, start + 1_000);
                return Response.json({
                    changes,
                    cursor: changes.at(-1)?.version ?? since,
                    hasMore: start + 1_000 < all.length,
                });
            }
            return Response.json({
                users: [
                    {
                        id: "uann",
                        kind: "user",
                        name: "Ann",
                        firstName: "Ann",
                        lastName: null,
                        photoUrl: null,
                    },
                    {
                        id: "abot",
                        kind: "agent",
                        name: "Agent",
                        firstName: "Agent",
                        lastName: null,
                        photoUrl: null,
                    },
                ],
            });
        }) as typeof globalThis.fetch;

        const dump = await readArtifactDataSnapshot("abc123", { fetch, token: "secret" });
        expect(dump.format).toBe("happy-artifact-data/1");
        expect(dump.artifactId).toBe("abc123");
        expect(dump.entries).toEqual(all);
        expect(dump.users).toEqual([
            { id: "uann", kind: "user", name: "Ann" },
            { id: "abot", kind: "agent", name: "Agent" },
        ]);
        expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
        expect(requests).toEqual([
            "GET /v0/artifacts/abc123/api/v1/kv/changes?limit=1000",
            `GET /v0/artifacts/abc123/api/v1/kv/changes?limit=1000&since=${all[999]!.version}`,
            "GET /v0/artifacts/abc123/api/v1/users?ids=uann,abot",
        ]);
    });

    it("explains a missing artifact and refuses an ID that is not one", async () => {
        const fetch = (async () =>
            Response.json({ code: "not_found" }, { status: 404 })) as typeof globalThis.fetch;
        await expect(readArtifactDataSnapshot("gone", { fetch, token: "t" })).rejects.toThrow(
            "The daemon has no artifact gone with data to copy.",
        );
        await expect(
            readArtifactDataSnapshot("../etc", { fetch, token: "t" }),
        ).rejects.toBeInstanceOf(AgentDaemonError);
    });
});
