import { access } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
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

/** A gym whose model makes exactly the tool call a scenario asks for. */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request) => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Log work settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(name: string, args: Record<string, unknown>) {
        const agentId = gym.defaultSessionId;
        const callId = `log_test_${String(++callIndex)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "read_only",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    return { gym, call };
}

describe("artifact debug logs", () => {
    it("keeps what pages report, as their person and version, for agents to read", async () => {
        const { gym, call } = await harness();
        const { artifact } = await gym.client.createArtifact({
            type: "html",
            title: "Scoreboard",
            files: [{ path: "index.html", text: '<script src="/api/v1/client.js"></script>' }],
        });
        const api = `/v0/artifacts/${artifact.id}/api/v1`;
        const me = (await gym.http.ok("GET", `${api}/me`)) as { user: { id: string } };

        const posted = await gym.http.request("POST", `${api}/debug/log`, {
            entries: [
                {
                    level: "error",
                    source: "uncaught",
                    message: "TypeError: board is undefined",
                    data: { stack: "at render (index.html:12)" },
                    at: 1_755_400_000_000,
                },
                { level: "info", source: "app", message: "opened the board" },
            ],
            url: "https://artifact.example/index.html",
        });
        expect(posted.status).toBe(200);
        expect(posted.body).toEqual({ accepted: 2, dropped: 0 });
        expect((await gym.http.request("POST", `${api}/debug/log`, { entries: [] })).status).toBe(
            400,
        );
        expect(
            (
                await gym.http.request("POST", `${api}/debug/log`, {
                    entries: [{ level: "fatal", source: "app", message: "x" }],
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await gym.http.request("POST", "/v0/artifacts/zzzznotreal/api/v1/debug/log", {
                    entries: [{ level: "info", source: "app", message: "x" }],
                })
            ).status,
        ).toBe(404);

        // A new version's reports carry that version, and the SDK reports on its own.
        await gym.client.updateArtifact(
            artifact.id,
            {
                files: [
                    {
                        path: "index.html",
                        text: '<script src="/api/v1/client.js"></script><p>v2</p>',
                    },
                ],
            },
            { ifMatch: artifact.version },
        );
        const page = await openArtifactPage(gym, artifact.id, pages);
        await page.happy.ready;
        page.happy.debug.log("scored", { points: 3 }, "warn");
        page.happy.debug.flush();
        await gym.waitUntil(
            () => page.requests.includes("POST /api/v1/debug/log") || undefined,
            "the page's report",
        );

        const all = await gym.waitUntil(async () => {
            const result = await call("read_artifact_logs", { artifactId: artifact.id });
            return result.text.includes("scored") ? result : undefined;
        }, "the agent to read the page's report");
        expect(all.text).toContain(`Artifact ${artifact.id} log, newest first, 3 entries:`);
        expect(all.text.indexOf("scored")).toBeLessThan(all.text.indexOf("opened the board"));
        expect(all.text).toContain("warn · app");
        expect(all.text).toContain(`(${me.user.id}) · version 2`);
        expect(all.text).toContain("error · uncaught");
        expect(all.text).toContain(`(${me.user.id}) · version 1`);
        expect(all.text).toContain('data: {"stack":"at render (index.html:12)"}');
        expect(all.text).toContain("page: https://artifact.example/index.html");

        const errors = await call("read_artifact_logs", {
            artifactId: artifact.id,
            level: "error",
        });
        expect(errors.text).toContain("1 entry:");
        expect(errors.text).toContain("TypeError: board is undefined");
        expect(errors.text).not.toContain("scored");

        const paged = await call("read_artifact_logs", { artifactId: artifact.id, limit: 1 });
        const cursor = /pass pageCursor "([0-9]+)"/.exec(paged.text)?.[1];
        expect(cursor).toBeDefined();
        const older = await call("read_artifact_logs", {
            artifactId: artifact.id,
            limit: 1,
            pageCursor: cursor,
        });
        expect(older.text).toContain("opened the board");

        const later = await call("read_artifact_logs", {
            artifactId: artifact.id,
            since: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(later.text).toContain("has no log entries that match");
        const nobody = await call("read_artifact_logs", {
            artifactId: artifact.id,
            userId: "unobody",
        });
        expect(nobody.text).toContain("has no log entries that match");

        // The log lives beside the data, in the artifact's own directory outside the main database.
        await access(
            join(gym.happyHome, "agent", "artifacts", "_data_", artifact.id, "logs.sqlite"),
        );
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("drops what one person reports past the rate of a minute", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        running.add(gym);
        const { artifact } = await gym.client.createArtifact({
            type: "html",
            title: "Noisy",
            files: [{ path: "index.html", text: "<p>noise</p>" }],
        });
        const api = `/v0/artifacts/${artifact.id}/api/v1`;
        const entries = Array.from({ length: 50 }, (_, index) => ({
            level: "warn",
            source: "console",
            message: `warning ${String(index)}`,
        }));
        const results: { accepted: number; dropped: number }[] = [];
        for (let batch = 0; batch < 3; batch += 1) {
            results.push(
                (await gym.http.ok("POST", `${api}/debug/log`, { entries })) as {
                    accepted: number;
                    dropped: number;
                },
            );
        }
        expect(results.reduce((sum, result) => sum + result.accepted, 0)).toBe(120);
        expect(results[2]).toEqual({ accepted: 20, dropped: 30 });
    });
});
