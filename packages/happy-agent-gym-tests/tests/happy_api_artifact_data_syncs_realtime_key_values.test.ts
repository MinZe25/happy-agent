import { readdir, stat } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import { createAgentGym, GymEventStream, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
const streams = new Set<GymEventStream>();
afterEach(async () => {
    for (const stream of streams) stream.close();
    streams.clear();
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function start(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 20_000 });
    running.add(gym);
    return gym;
}

async function createApp(gym: AgentGym): Promise<string> {
    const { artifact } = await gym.client.createArtifact({
        type: "html",
        title: "Shared todos",
        files: [{ path: "index.html", text: '<script src="/api/v1/client.js"></script>' }],
    });
    return artifact.id;
}

interface Reply {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly text: string;
    readonly body: any;
}

/** One request exactly as written, the way a client forwards a page's `/api/*` call. */
async function call(
    gym: AgentGym,
    method: string,
    path: string,
    options: { body?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
    const payload =
        options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    return await new Promise((resolve, reject) => {
        const sent = httpRequest(
            {
                socketPath: gym.socketPath,
                path,
                method,
                headers: {
                    authorization: `Bearer ${gym.token}`,
                    ...(payload === undefined
                        ? {}
                        : {
                              "content-type": "application/json",
                              "content-length": String(Buffer.byteLength(payload)),
                          }),
                    ...options.headers,
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let body: unknown;
                    try {
                        body = JSON.parse(text);
                    } catch {
                        body = undefined;
                    }
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        text,
                        body,
                    });
                });
            },
        );
        sent.on("error", reject);
        sent.end(payload);
    });
}

function api(artifactId: string, rest: string): string {
    return `/v0/artifacts/${artifactId}/api/v1/${rest}`;
}

function entryPath(artifactId: string, key: string): string {
    return api(artifactId, `kv/entry?key=${encodeURIComponent(key)}`);
}

function events(gym: AgentGym, artifactId: string, query = "", lastEventId?: string) {
    const stream = new GymEventStream({
        path: api(artifactId, `kv/events${query}`),
        socketPath: gym.socketPath,
        token: gym.token,
        timeoutMs: 20_000,
        ...(lastEventId === undefined ? {} : { lastEventId }),
    });
    streams.add(stream);
    return stream;
}

async function findFiles(root: string, name: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name === name) found.push(join(entry.parentPath, entry.name));
    }
    return found;
}

describe("artifact data over the API", () => {
    it("stores versioned values, answers retries once, and guards compare-and-set", async () => {
        const gym = await start();
        const id = await createApp(gym);

        const me = await call(gym, "GET", api(id, "me"));
        expect(me.status).toBe(200);
        expect(me.body.user).toEqual({
            id: expect.stringMatching(/^[a-z][a-z0-9]+$/),
            kind: "user",
            name: null,
            firstName: null,
            lastName: null,
            photoUrl: null,
        });
        const userId = me.body.user.id as string;
        expect((await call(gym, "GET", api(id, `users?ids=${userId},zzzz`))).body).toEqual({
            users: [me.body.user],
        });

        // A store nobody wrote to is empty and has no file yet.
        expect((await call(gym, "GET", api(id, "kv"))).body).toEqual({
            entries: [],
            nextPageCursor: null,
            cursor: null,
        });
        expect(await findFiles(gym.happyHome, "kv.sqlite")).toEqual([]);
        expect((await call(gym, "GET", entryPath(id, "todos/1"))).body).toEqual({
            entry: null,
            cursor: null,
        });

        const first = await call(gym, "PUT", entryPath(id, "todos/1"), {
            body: { value: { title: "Milk", done: false }, writeId: "w-1" },
        });
        expect(first.status).toBe(200);
        expect(first.body).toEqual({
            entry: {
                key: "todos/1",
                value: { title: "Milk", done: false },
                deleted: false,
                version: expect.stringMatching(UUID_V7),
                updatedBy: userId,
                updatedAt: expect.any(Number),
                writeId: "w-1",
            },
            replayed: false,
        });
        const version = first.body.entry.version as string;
        // The version carries the time it was written.
        expect(Number.parseInt(version.replaceAll("-", "").slice(0, 12), 16)).toBe(
            first.body.entry.updatedAt,
        );
        expect(Math.abs(first.body.entry.updatedAt - Date.now())).toBeLessThan(60_000);

        // A retried write is answered with its first result and changes nothing.
        const retried = await call(gym, "PUT", entryPath(id, "todos/1"), {
            body: { value: { title: "Milk", done: false }, writeId: "w-1" },
        });
        expect(retried.body).toEqual({ entry: first.body.entry, replayed: true });
        const reused = await call(gym, "PUT", entryPath(id, "todos/2"), {
            body: { value: 1, writeId: "w-1" },
        });
        expect(reused.status).toBe(400);

        // Compare-and-set against the current version, or against no value at all.
        const stale = await call(gym, "PUT", entryPath(id, "todos/1"), {
            body: { value: "x" },
            headers: { "if-match": '"01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"' },
        });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ code: "conflict", entry: first.body.entry });
        const occupied = await call(gym, "PUT", entryPath(id, "todos/1"), {
            body: { value: "x" },
            headers: { "if-none-match": "*" },
        });
        expect(occupied.status).toBe(409);
        const done = await call(gym, "PUT", entryPath(id, "todos/1"), {
            body: { value: { title: "Milk", done: true } },
            headers: { "if-match": `"${version}"` },
        });
        expect(done.status).toBe(200);
        expect(done.body.entry.version > version).toBe(true);
        const created = await call(gym, "PUT", entryPath(id, "todos/2"), {
            body: { value: { title: "Eggs", done: false } },
            headers: { "if-none-match": "*" },
        });
        expect(created.status).toBe(200);
        await call(gym, "PUT", entryPath(id, "settings"), { body: { value: null } });

        const list = await call(gym, "GET", api(id, "kv?prefix=todos%2F&limit=1"));
        expect(list.body).toEqual({
            entries: [done.body.entry],
            nextPageCursor: "todos/1",
            cursor: expect.stringMatching(UUID_V7),
        });
        const next = await call(
            gym,
            "GET",
            api(id, "kv?prefix=todos%2F&limit=1&pageCursor=todos%2F1"),
        );
        expect(next.body).toMatchObject({ entries: [created.body.entry], nextPageCursor: null });

        // A deletion is a tombstone that a client catching up hears about.
        const removed = await call(gym, "DELETE", entryPath(id, "todos/2"), {
            body: { writeId: "w-del" },
        });
        expect(removed.body.entry).toMatchObject({ key: "todos/2", deleted: true, value: null });
        expect((await call(gym, "GET", entryPath(id, "todos/2"))).body.entry).toBeNull();
        const changes = await call(gym, "GET", api(id, `kv/changes?since=${version}`));
        expect(changes.body).toEqual({
            changes: [
                done.body.entry,
                expect.objectContaining({ key: "settings", value: null, deleted: false }),
                removed.body.entry,
            ],
            cursor: removed.body.entry.version,
            hasMore: false,
        });
        expect(
            (await call(gym, "GET", api(id, `kv/changes?since=${removed.body.entry.version}`)))
                .body,
        ).toEqual({ changes: [], cursor: removed.body.entry.version, hasMore: false });

        // Limits and malformed requests.
        const huge = await call(gym, "PUT", entryPath(id, "big"), {
            body: { value: "x".repeat(300 * 1024) },
        });
        expect(huge.status).toBe(413);
        expect((await call(gym, "PUT", entryPath(id, "bad"), { raw: "{" })).status).toBe(400);
        expect((await call(gym, "PUT", api(id, "kv/entry"), { body: { value: 1 } })).status).toBe(
            400,
        );
        expect((await call(gym, "GET", api(id, "kv/changes?since=nope"))).status).toBe(400);
        expect(
            (
                await call(
                    gym,
                    "GET",
                    api(id, "kv/changes?since=7fffffff-ffff-7fff-bfff-ffffffffffff"),
                )
            ).body.code,
        ).toBe("cursor_unavailable");
        expect((await call(gym, "GET", api(id, "nothing"))).status).toBe(404);

        // The store is one file in the artifacts folder's `_data_` directory.
        const files = await findFiles(gym.happyHome, "kv.sqlite");
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(
            new RegExp(`artifacts[/\\\\]_data_[/\\\\]${id}[/\\\\]kv\\.sqlite$`),
        );
        expect((await stat(files[0]!)).size).toBeGreaterThan(0);
        expect(gym.errors).toEqual([]);
    });

    it("streams changes live, resumes from a version, and survives a restart", async () => {
        const gym = await start();
        const id = await createApp(gym);
        const other = await createApp(gym);

        const live = events(gym, id);
        await live.opened();
        await live.waitFor((frame) => frame.event === "ready", "the stream to be ready");
        expect(live.frames[0]).toMatchObject({ event: "ready", data: { cursor: null } });

        const a = await call(gym, "PUT", entryPath(id, "a"), { body: { value: 1 } });
        await call(gym, "PUT", entryPath(other, "a"), { body: { value: "elsewhere" } });
        const b = await call(gym, "PUT", entryPath(id, "b"), { body: { value: 2 } });
        await live.waitFor(
            (frame) => frame.event === "change" && frame.id === b.body.entry.version,
            "the second change",
        );
        const changes = live.frames.filter((frame) => frame.event === "change");
        expect(changes.map((frame) => [frame.id, frame.data])).toEqual([
            [a.body.entry.version, a.body.entry],
            [b.body.entry.version, b.body.entry],
        ]);

        // Resuming sends what was missed, then `ready`, then live changes.
        const c = await call(gym, "DELETE", entryPath(id, "a"));
        const resumed = events(gym, id, `?since=${a.body.entry.version}`);
        await resumed.waitFor((frame) => frame.event === "ready", "the resumed stream");
        expect(resumed.frames.map((frame) => [frame.event, frame.id])).toEqual([
            ["change", b.body.entry.version],
            ["change", c.body.entry.version],
            ["ready", undefined],
        ]);
        expect(resumed.frames.at(-1)?.data).toEqual({ cursor: c.body.entry.version });

        const byHeader = events(gym, id, "?prefix=b", b.body.entry.version);
        await byHeader.waitFor((frame) => frame.event === "ready", "the Last-Event-ID stream");
        expect(byHeader.frames.map((frame) => frame.event)).toEqual(["ready"]);
        const d = await call(gym, "PUT", entryPath(id, "b"), { body: { value: 3 } });
        await call(gym, "PUT", entryPath(id, "c"), { body: { value: 4 } });
        await byHeader.waitFor((frame) => frame.id === d.body.entry.version, "the prefixed change");
        await live.waitFor(
            (frame) => (frame.data as { key?: string } | undefined)?.key === "c",
            "the unprefixed change",
        );
        expect(byHeader.frames.filter((frame) => frame.event === "change")).toHaveLength(1);

        // A cursor the store never issued is a reset, after which the client reads again.
        const unknown = events(gym, id, "?since=7fffffff-ffff-7fff-bfff-ffffffffffff");
        await unknown.waitFor((frame) => frame.event === "reset", "the reset");
        expect(unknown.frames[0]?.data).toEqual({ reason: "cursor_unavailable" });

        // Everything is durable, and versions keep increasing after a restart.
        const before = (await call(gym, "GET", api(id, "kv"))).body;
        for (const stream of streams) stream.close();
        await gym.restart();
        expect((await call(gym, "GET", api(id, "kv"))).body).toEqual(before);
        const after = await call(gym, "PUT", entryPath(id, "b"), { body: { value: 5 } });
        expect(after.body.entry.version > d.body.entry.version).toBe(true);
        const replay = await call(gym, "GET", api(id, `kv/changes?since=${d.body.entry.version}`));
        expect(replay.body.changes.map((entry: { key: string }) => entry.key)).toEqual(["c", "b"]);
        expect(gym.errors).toEqual([]);
    });

    it("serves the browser SDK and stops serving a deleted artifact", async () => {
        const gym = await start();
        const id = await createApp(gym);

        const client = await call(gym, "GET", api(id, "client.js"));
        expect(client.status).toBe(200);
        expect(client.headers["content-type"]).toBe("text/javascript; charset=utf-8");
        expect(client.text).toContain("global.happy = happy");
        const cached = await call(gym, "GET", api(id, "client.js"), {
            headers: { "if-none-match": String(client.headers.etag) },
        });
        expect(cached.status).toBe(304);

        await call(gym, "PUT", entryPath(id, "kept"), { body: { value: "still on disk" } });
        const stream = events(gym, id);
        await stream.waitFor((frame) => frame.event === "ready", "the stream");
        const { artifact } = await gym.client.getArtifact(id);
        await gym.client.deleteArtifact(id, { ifMatch: artifact.version });
        await stream.waitFor((frame) => frame.event === "closed", "the stream to close");
        expect(stream.frames.at(-1)?.data).toEqual({ reason: "artifact_deleted" });

        expect((await call(gym, "GET", api(id, "kv"))).status).toBe(404);
        expect((await call(gym, "PUT", entryPath(id, "x"), { body: { value: 1 } })).status).toBe(
            404,
        );
        expect((await call(gym, "GET", api(id, "client.js"))).status).toBe(404);
        expect((await call(gym, "GET", api("nosuchartifact", "me"))).status).toBe(404);
        // Deletion never erases durable data.
        expect(await findFiles(gym.happyHome, "kv.sqlite")).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });
});
