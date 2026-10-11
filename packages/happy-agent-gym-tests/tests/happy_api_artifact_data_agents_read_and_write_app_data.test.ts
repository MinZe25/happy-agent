import {
    createAgentGym,
    GymEventStream,
    type AgentGym,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
const streams = new Set<GymEventStream>();
afterEach(async () => {
    for (const stream of streams) stream.close();
    streams.clear();
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
            return { content: [{ type: "text", text: "Data work settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(name: string, args: Record<string, unknown>) {
        const agentId = gym.defaultSessionId;
        const callId = `data_test_${String(++callIndex)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "auto",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    return { gym, call };
}

describe("agents and artifact app data", () => {
    it("lets an agent read what people wrote and write as itself, live to every page", async () => {
        const { gym, call } = await harness();
        const { artifact } = await gym.client.createArtifact({
            type: "html",
            title: "Lunch poll",
            files: [{ path: "index.html", text: '<script src="/api/v1/client.js"></script>' }],
        });
        const api = `/v0/artifacts/${artifact.id}/api/v1`;
        const me = (await gym.http.ok("GET", `${api}/me`)) as { user: { id: string } };
        await gym.http.ok("PUT", `${api}/kv/entry?key=${encodeURIComponent("votes/steve")}`, {
            value: { choice: "pizza" },
        });

        const stream = new GymEventStream({
            path: `${api}/kv/events`,
            socketPath: gym.socketPath,
            token: gym.token,
            timeoutMs: 20_000,
        });
        streams.add(stream);
        await stream.waitFor((frame) => frame.event === "ready", "the page's stream");

        const read = await call("read_artifact_data", {
            artifactId: artifact.id,
            prefix: "votes/",
        });
        expect(read.text).toContain('"votes/steve"');
        expect(read.text).toContain('{"choice":"pizza"}');
        expect(read.text).toContain(`(user ${me.user.id})`);

        const written = await call("write_artifact_data", {
            artifactId: artifact.id,
            key: "summary",
            value: JSON.stringify({ winner: "pizza", votes: 1 }),
            ifAbsent: true,
        });
        expect(written.text).toContain('Set "summary"');
        const frame = await stream.waitFor(
            (candidate) => candidate.event === "change",
            "the agent's change",
        );
        const entry = frame.data as { key: string; value: unknown; updatedBy: string };
        expect(entry).toMatchObject({ key: "summary", value: { winner: "pizza", votes: 1 } });
        // The page sees a stable author ID of its own, never the agent's ID.
        expect(entry.updatedBy).toMatch(/^a[a-z0-9]{23}$/);
        expect(JSON.stringify(frame.data)).not.toContain(gym.defaultSessionId);
        const users = (await gym.http.ok(
            "GET",
            `${api}/users?ids=${entry.updatedBy},${me.user.id}`,
        )) as { users: unknown[] };
        expect(users.users).toEqual([
            {
                id: entry.updatedBy,
                kind: "agent",
                name: "Agent",
                firstName: "Agent",
                lastName: null,
                photoUrl: null,
            },
            expect.objectContaining({ id: me.user.id, kind: "user" }),
        ]);

        // A condition that no longer holds writes nothing and tells the agent what is there.
        const refused = await call("write_artifact_data", {
            artifactId: artifact.id,
            key: "summary",
            value: "null",
            ifAbsent: true,
        });
        expect(refused.text).toContain("so nothing was written");
        const removed = await call("write_artifact_data", {
            artifactId: artifact.id,
            key: "votes/steve",
            delete: true,
        });
        expect(removed.text).toContain('Deleted "votes/steve"');
        const one = await call("read_artifact_data", {
            artifactId: artifact.id,
            key: "votes/steve",
        });
        expect(one.text).toContain('holds no value at "votes/steve"');
        const listed = (await gym.http.ok("GET", `${api}/kv`)) as { entries: { key: string }[] };
        expect(listed.entries.map((item) => item.key)).toEqual(["summary"]);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
