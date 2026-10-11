import { createUnixSocketFetch, type AgentGym } from "@slopus/happy-agent-gym";

/* The SDK is untyped browser code; the test reads it the way a page script would. */
export type Happy = any;

export interface ArtifactPage {
    readonly happy: Happy;
    readonly heard: string[];
    readonly statuses: string[];
    /** Every request the page made, as `METHOD /api/...`, oldest first. */
    readonly requests: string[];
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
export async function openArtifactPage(
    gym: AgentGym,
    artifactId: string,
    pages: Set<ArtifactPage>,
): Promise<ArtifactPage> {
    const socketFetch = createUnixSocketFetch(gym.socketPath);
    const prefix = `http://daemon/v0/artifacts/${artifactId}`;
    const open = new Set<AbortController>();
    const listeners: (() => void)[] = [];
    let online = true;
    let closed = false;
    let lose = 0;
    const requests: string[] = [];
    const pageFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
        if (!online || closed) throw new TypeError("Failed to fetch");
        requests.push(`${init.method ?? "GET"} ${input}`);
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
    const page: ArtifactPage = {
        happy,
        heard,
        statuses,
        requests,
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
