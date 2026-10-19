/**
 * Measures what Happy Desktop asks for when it opens a conversation, against a running perf
 * daemon: the same four reads `loadSession` issues in parallel, plus the desktop bootstrap.
 */
import { readFile } from "node:fs/promises";
import { request } from "node:http";

const socketPath = required("PERF_SOCKET");
const token = (await readFile(required("PERF_TOKEN"), "utf8")).trim();
const agents = (process.env.PERF_AGENTS ?? "").split(",").filter(Boolean);
const repeats = Number(process.env.PERF_REPEATS ?? "3");
const omit = process.env.PERF_OMIT_TOOL_DATA === "1";
const limit = process.env.PERF_LIMIT ?? "100";

interface Timed {
    readonly ms: number;
    readonly bytes: number;
    readonly status: number;
}

function get(path: string): Promise<Timed> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
        const req = request(
            { headers: { authorization: `Bearer ${token}` }, path, socketPath },
            (res) => {
                let bytes = 0;
                res.on("data", (chunk: Buffer) => (bytes += chunk.length));
                res.on("end", () =>
                    resolve({
                        bytes,
                        ms: performance.now() - started,
                        status: res.statusCode ?? 0,
                    }),
                );
            },
        );
        req.on("error", reject);
        req.end();
    });
}

const fmt = (t: Timed) =>
    `${t.ms.toFixed(0).padStart(5)}ms ${(t.bytes / 1024).toFixed(0).padStart(6)}KB`;

for (let i = 0; i < repeats; i += 1) {
    console.log(`desktop bootstrap  ${fmt(await get("/v0/bootstrap/desktop"))}`);
}
for (const agent of agents) {
    for (let i = 0; i < repeats; i += 1) {
        const started = performance.now();
        const [messages, bootstrap, activity, question] = await Promise.all([
            get(`/v0/agents/${agent}/messages?limit=${limit}&omitToolData=${String(omit)}`),
            get(`/v0/agents/${agent}/bootstrap`),
            get(`/v0/agents/${agent}/activity`),
            get(`/v0/agents/${agent}/question`),
        ]);
        const total = performance.now() - started;
        console.log(
            `${agent} open ${total.toFixed(0).padStart(5)}ms | messages ${fmt(messages)} | bootstrap ${bootstrap.status} ${fmt(bootstrap)} | activity ${fmt(activity)} | question ${question.status} ${question.ms.toFixed(0)}ms`,
        );
        if (i === repeats - 1) {
            const solo: string[] = [];
            for (const path of [
                `messages?limit=${limit}&omitToolData=${String(omit)}`,
                "bootstrap",
                "activity",
                "question",
            ]) {
                const timed = await get(`/v0/agents/${agent}/${path}`);
                solo.push(`${path.split("?")[0]} ${timed.ms.toFixed(0)}ms`);
            }
            console.log(`    solo: ${solo.join(" | ")}`);
        }
    }
}

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
    return value;
}
