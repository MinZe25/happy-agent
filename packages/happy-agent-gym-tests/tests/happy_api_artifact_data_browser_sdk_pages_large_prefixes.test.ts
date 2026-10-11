import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { openArtifactPage, type ArtifactPage } from "./support/openArtifactPage.js";

const running = new Set<AgentGym>();
const pages = new Set<ArtifactPage>();
afterEach(async () => {
    for (const page of pages) page.close();
    pages.clear();
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** More keys than one listing page of 1,000 holds, so a complete read needs a second page. */
const KEYS = 1_005;

function key(index: number): string {
    return `items/${String(index).padStart(5, "0")}`;
}

describe("the artifact browser SDK with large prefixes", () => {
    it("pages a listing with pageCursor and stops when the last page arrives", async () => {
        const gym = await createAgentGym({ timeoutMs: 30_000 });
        running.add(gym);
        const { artifact } = await gym.client.createArtifact({
            type: "html",
            title: "Inventory",
            files: [{ path: "index.html", text: '<script src="/api/v1/client.js"></script>' }],
        });
        const api = `/v0/artifacts/${artifact.id}/api/v1`;
        for (let index = 0; index < KEYS; index += 1) {
            await gym.http.ok("PUT", `${api}/kv/entry?key=${encodeURIComponent(key(index))}`, {
                value: index,
            });
        }
        await gym.http.ok("PUT", `${api}/kv/entry?key=other`, { value: "outside the prefix" });

        // The route itself continues from pageCursor.
        type Page = { entries: { key: string }[]; nextPageCursor: string | null };
        const first = await gym.http.ok<Page>("GET", `${api}/kv?prefix=items%2F&limit=1000`);
        expect(first.entries).toHaveLength(1000);
        expect(first.nextPageCursor).toBe(key(999));
        const second = await gym.http.ok<Page>(
            "GET",
            `${api}/kv?prefix=items%2F&limit=1000&pageCursor=${encodeURIComponent(key(999))}`,
        );
        expect(second.entries.map((entry) => entry.key)).toEqual(
            Array.from({ length: KEYS - 1000 }, (_, offset) => key(1000 + offset)),
        );
        expect(second.nextPageCursor).toBeNull();

        const page = await openArtifactPage(gym, artifact.id, pages);
        await page.happy.ready;
        const listed = (await page.happy.kv.list("items/")) as { key: string }[];
        const expected = Array.from({ length: KEYS }, (_, index) => key(index));
        expect(listed.map((entry) => entry.key)).toEqual(expected);

        const tracker = page.happy.kv.trackPrefix("items/");
        await gym.waitUntil(() => tracker.loaded || undefined, "the tracker to load every page");
        expect(tracker.entries.map((entry: { key: string }) => entry.key)).toEqual(expected);
        await gym.waitUntil(
            () => page.happy.status === "online" || undefined,
            "the page to settle",
        );

        // Each read asked for exactly two pages, the second from the first page's cursor.
        const listings = page.requests.filter((request) => request.startsWith("GET /api/v1/kv?"));
        expect(listings).toHaveLength(4);
        expect(listings.filter((request) => request.includes("pageCursor="))).toHaveLength(2);
        expect(listings.some((request) => request.includes("after="))).toBe(false);
        // Later changes arrive over the stream; nothing asks for a listing again.
        await gym.http.ok("PUT", `${api}/kv/entry?key=${encodeURIComponent(key(KEYS))}`, {
            value: KEYS,
        });
        await gym.waitUntil(
            () => tracker.entries.length === KEYS + 1 || undefined,
            "the tracker to hear the new key",
        );
        expect(page.requests.filter((request) => request.startsWith("GET /api/v1/kv?"))).toEqual(
            listings,
        );
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
