import { createAgentGym, createUnixSocketFetch, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
const pages = new Set<Page>();
afterEach(async () => {
    for (const page of pages) page.close();
    pages.clear();
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/* The SDK is untyped browser code; the test reads it the way a page script would. */
type Happy = any;

interface Page {
    readonly happy: Happy;
    readonly heard: string[];
    readonly statuses: string[];
    offline(): void;
    online(): void;
    /** Let the next N writes reach the daemon but lose their responses. */
    loseResponses(count: number): void;
    close(): void;
}

/**
 * One artifact page: the daemon's own `client.js` evaluated against a `fetch` that forwards
 * `/api/*` to the artifact's API prefix with the token added, exactly as a desktop client does.
 * Going offline fails every request and cuts open streams, the way a dropped network does.
 */
async function openPage(gym: AgentGym, artifactId: string): Promise<Page> {
    const socketFetch = createUnixSocketFetch(gym.socketPath);
    const prefix = `http://daemon/v0/artifacts/${artifactId}`;
    const open = new Set<AbortController>();
    const listeners: (() => void)[] = [];
    let online = true;
    let closed = false;
    let lose = 0;
    const pageFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
        if (!online || closed) throw new TypeError("Failed to fetch");
        const controller = new AbortController();
        open.add(controller);
        init.signal?.addEventListener("abort", () => controller.abort());
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${gym.token}`);
        try {
            const response = await socketFetch(`${prefix}${input}`, {
                ...init,
                headers,
                signal: controller.signal,
            });
            if (lose > 0 && (init.method === "PUT" || init.method === "DELETE")) {
                lose -= 1;
                await response.arrayBuffer();
                throw new TypeError("Failed to fetch");
            }
            return response;
        } finally {
            if (init.signal === undefined) open.delete(controller);
        }
    };
    const script = await (await pageFetch("/api/v1/client.js")).text();
    const window: Record<string, unknown> = {
        fetch: pageFetch,
        crypto: globalThis.crypto,
        addEventListener: (type: string, listener: () => void) => {
            if (type === "online") listeners.push(listener);
        },
    };
    new Function("window", script)(window);
    const happy = window["happy"] as Happy;
    const heard: string[] = [];
    const statuses: string[] = [];
    happy.kv.onChange((entry: { key: string }) => heard.push(entry.key));
    happy.onStatus((status: string) => statuses.push(status));
    const cut = (): void => {
        for (const controller of open) controller.abort();
        open.clear();
    };
    const page: Page = {
        happy,
        heard,
        statuses,
        offline: () => {
            online = false;
            cut();
        },
        online: () => {
            online = true;
            for (const listener of listeners) listener();
        },
        loseResponses: (count) => {
            lose = count;
        },
        close: () => {
            closed = true;
            cut();
        },
    };
    pages.add(page);
    return page;
}

function titles(tracker: Happy): string[] {
    return tracker.entries.map((entry: { value: { title: string } }) => entry.value.title);
}

describe("the artifact browser SDK", () => {
    it("shares tracked values between pages and syncs writes made offline", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        running.add(gym);
        const { artifact } = await gym.client.createArtifact({
            type: "html",
            title: "Shared todos",
            files: [{ path: "index.html", text: '<script src="/api/v1/client.js"></script>' }],
        });
        const a = await openPage(gym, artifact.id);
        const b = await openPage(gym, artifact.id);
        await Promise.all([a.happy.ready, b.happy.ready]);
        expect(a.happy.status).toBe("online");
        expect(a.happy.user).toMatchObject({ id: expect.any(String), name: null });
        expect(a.happy.user.id).toBe(b.happy.user.id);

        const todosA = a.happy.kv.trackPrefix("todos/");
        const todosB = b.happy.kv.trackPrefix("todos/");
        await gym.waitUntil(
            () => (todosA.loaded && todosB.loaded) || undefined,
            "trackers to load",
        );

        // A write shows at once where it was made and reaches the other page live.
        const written = a.happy.kv.set("todos/1", { title: "Milk" });
        expect(titles(todosA)).toEqual(["Milk"]);
        expect(todosA.pending).toBe(true);
        const milk = await written;
        expect(milk).toMatchObject({ key: "todos/1", updatedBy: a.happy.user.id });
        expect(a.happy.timeOf(milk.version).getTime()).toBe(milk.updatedAt);
        await gym.waitUntil(() => titles(todosB).length === 1 || undefined, "page B to hear Milk");
        expect(todosB.get("todos/1")).toMatchObject({ value: { title: "Milk" }, pending: false });
        expect(todosA.synced).toBe(true);

        // Offline, writes stay pending locally and are delivered once the network returns.
        a.offline();
        await gym.waitUntil(() => a.happy.status === "offline" || undefined, "page A offline");
        const eggs = a.happy.kv.set("todos/2", { title: "Eggs" });
        expect(titles(todosA)).toEqual(["Milk", "Eggs"]);
        expect(todosA.synced).toBe(false);
        expect(a.happy.pending).toBe(1);
        expect(titles(todosB)).toEqual(["Milk"]);
        a.online();
        await eggs;
        await a.happy.flush();
        await gym.waitUntil(() => titles(todosB).length === 2 || undefined, "page B to hear Eggs");
        await gym.waitUntil(() => a.happy.status === "online" || undefined, "page A back online");
        expect(a.statuses).toContain("offline");
        expect(todosA.synced).toBe(true);

        // A write whose response is lost is retried with the same write ID and applied once.
        a.loseResponses(1);
        const counted = await a.happy.kv.set("counter", 1);
        await gym.waitUntil(
            () => b.heard.filter((key) => key === "counter").length === 1 || undefined,
            "page B to hear the counter",
        );
        const feed = await gym.http.ok(
            "GET",
            `/v0/artifacts/${artifact.id}/api/v1/kv/changes?since=${milk.version}`,
        );
        expect((feed as { changes: { key: string; writeId: string }[] }).changes).toContainEqual(
            expect.objectContaining({ key: "counter", writeId: counted.writeId }),
        );

        // Concurrent read-modify-write retries on conflict, so no increment is lost.
        await Promise.all([
            a.happy.kv.update("counter", (n: number) => n + 1),
            b.happy.kv.update("counter", (n: number) => n + 1),
            a.happy.kv.update("counter", (n: number) => n + 1),
        ]);
        expect(await a.happy.kv.entry("counter")).toMatchObject({ value: 4 });

        // A page that was away learns of a deletion it missed when its stream resumes.
        b.offline();
        await gym.waitUntil(() => b.happy.status === "offline" || undefined, "page B offline");
        await a.happy.kv.delete("todos/1");
        expect(titles(todosA)).toEqual(["Eggs"]);
        b.online();
        await gym.waitUntil(
            () => titles(todosB).join() === "Eggs" || undefined,
            "page B to resync",
        );
        expect(b.heard.filter((key) => key === "todos/1")).toHaveLength(2);
        expect(gym.errors).toEqual([]);
    });
});
