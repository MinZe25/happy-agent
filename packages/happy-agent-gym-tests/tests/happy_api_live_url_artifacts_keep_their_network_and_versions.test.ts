import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function harness() {
    let command: GymTurn | undefined;
    let outcome = "allow";
    const reviews: string[] = [];
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        permissionMode: "auto",
        inference: (request) => {
            if (request.instructions.includes("<outcome>")) {
                reviews.push(JSON.stringify(request.messages));
                return {
                    content: [
                        {
                            type: "text",
                            text: `<review><outcome>${outcome}</outcome><risk_level>high</risk_level><user_authorization>high</user_authorization><rationale>Scripted live artifact review.</rationale></review>`,
                        },
                    ],
                };
            }
            if (!request.sessionId.startsWith("naming:") && command !== undefined) {
                const turn = command;
                command = undefined;
                return turn;
            }
            return { content: [{ type: "text", text: "Live artifact work settled." }] };
        },
    });
    running.add(gym);
    let calls = 0;
    return {
        gym,
        reviews,
        deny: () => {
            outcome = "deny";
        },
        call: async (name: string, args: Record<string, unknown>) => {
            const callId = `liveartifact${++calls}`;
            command = { content: [{ type: "tool_call", name, arguments: args, callId }] };
            const sent = await gym.send(`Execute ${name} for the live page, request ${callId}.`, {
                permissionMode: "auto",
            });
            const result = await gym.waitUntil(
                async () => gym.inference.toolResults().find((result) => result.callId === callId),
                "the live artifact tool result",
            );
            const history = await gym.client.getMessages(gym.defaultSessionId);
            const block = history.runs
                .find((run) => run.id === sent.runId)
                ?.messages.flatMap((message) => message.content)
                .find((item) => item.type === "tool_call" && item.name === name);
            if (block?.type !== "tool_call")
                throw new Error(`No recorded ${name} call in the run.`);
            return { ...result, isError: block.status === "failed" };
        },
    };
}

describe("live URL artifacts", () => {
    it("versions URLs and metadata, retains the originating network and survives restart", async () => {
        const { gym, call, reviews } = await harness();
        const before = (await gym.client.getEvents()).latestCursor;
        const created = await call("create_artifact", {
            type: "html",
            title: "Preview <script>",
            url: "http://localhost:5173",
            display: "inline_expanded",
        });
        expect(created.isError).not.toBe(true);
        const [artifact] = (await gym.client.listArtifacts()).artifacts;
        expect(artifact).toBeDefined();
        const id = artifact!.id;
        const { networkId } = await gym.client.getWorkspaceAgentNetwork(
            (await gym.getSession()).workspaceId,
            gym.defaultSessionId,
        );
        expect(artifact).toMatchObject({
            live: { url: "http://localhost:5173/", networkId },
            display: "inline_expanded",
            fileCount: 1,
            latestVersion: 1,
        });
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toContain("localhost:5173");
        expect(reviews[0]).toContain(networkId);
        const fallback = await gym.client.getArtifactFile(id, 1, "index.html");
        const html = Buffer.from(fallback!.data).toString();
        expect(html).not.toContain("Preview");
        expect(html).toContain("This is a live page.");
        expect(html).toContain("newer Happy");
        expect(html).not.toMatch(/<script|<iframe|localhost|http-equiv|href=/i);

        await call("update_artifact", { artifactId: id, url: "https://example.com/new" });
        await call("update_artifact", { artifactId: id, display: "side" });
        expect(reviews).toHaveLength(3);
        const updated = (await gym.client.getArtifact(id)).artifact;
        expect(updated).toMatchObject({
            live: { url: "https://example.com/new", networkId },
            latestVersion: 3,
            latestMajor: 1,
            latestMinor: 2,
            display: "side",
        });
        const retitled = (
            await gym.client.updateArtifact(
                id,
                { title: "New title" },
                { ifMatch: updated.version },
            )
        ).artifact;
        expect(retitled.live).toEqual(updated.live);
        expect(
            Buffer.from(
                (await gym.client.getArtifactFile(id, "latest", "index.html"))!.data,
            ).toString(),
        ).toBe(html);
        expect(retitled.entry).toEqual(artifact!.entry);
        expect((await gym.client.getArtifactVersion(id, 1)).version.live).toEqual(artifact!.live);
        expect(gym.machineConnections).toHaveLength(0);

        const history = await gym.client.getMessages(gym.defaultSessionId, { omitToolData: true });
        const blocks = history.runs
            .flatMap((run) => run.messages)
            .flatMap((message) => message.content);
        expect(blocks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "tool_call",
                    name: "create_artifact",
                    presentation: expect.objectContaining({
                        type: "artifact",
                        artifactId: id,
                        shows: "latest",
                    }),
                }),
            ]),
        );
        const changes = (await gym.client.getEvents({ after: before, limit: 1000 })).events.filter(
            (event) => event.type === "artifact.updated",
        );
        expect(changes).toHaveLength(3);
        for (const event of changes) expect(event.payload.changes.live).toEqual(updated.live);
        await gym.restart();
        expect((await gym.client.getArtifact(id)).artifact).toEqual(retitled);
        expect((await gym.client.getArtifactVersion(id, 1)).version.live).toEqual(artifact!.live);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("keeps the deprecated show_page tool, rejects edits, and honors denied updates", async () => {
        const { gym, call, reviews, deny } = await harness();
        const result = await call("show_page", {
            title: "Dev server",
            url: "http://localhost:5173/",
        });
        expect(result.isError).not.toBe(true);
        const artifact = (await gym.client.listArtifacts()).artifacts[0]!;
        expect(artifact).toMatchObject({
            type: "html",
            live: { url: "http://localhost:5173/" },
            display: null,
        });
        const history = await gym.client.getMessages(gym.defaultSessionId);
        expect(
            history.runs.flatMap((run) => run.messages).flatMap((message) => message.content),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "show_page",
                    presentation: expect.objectContaining({
                        type: "artifact",
                        artifactId: artifact.id,
                        shows: "latest",
                    }),
                }),
            ]),
        );
        for (const [name, args] of [
            ["write_artifact_file", { path: "index.html", content: "changed" }],
            [
                "edit_artifact_file",
                { path: "index.html", old_string: "missing", new_string: "changed" },
            ],
        ] as const) {
            const rejected = await call(name, { artifactId: artifact.id, ...args });
            expect(rejected.isError).toBe(true);
            expect(rejected.text).toContain("live URL");
        }
        for (const change of [{ files: [] }, { remove: [] }, { replaceAll: false }]) {
            await expect(
                gym.client.updateArtifact(artifact.id, change, { ifMatch: artifact.version }),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        }
        deny();
        const refused = await call("update_artifact", {
            artifactId: artifact.id,
            url: "https://example.com/denied",
        });
        expect(refused.isError).toBe(true);
        expect(reviews).toHaveLength(2);
        expect((await gym.client.getArtifact(artifact.id)).artifact).toEqual(artifact);
        expect((await gym.client.listArtifactVersions(artifact.id)).versions).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });

    it("denies live creation without publishing a fallback or artifact", async () => {
        const { gym, call, reviews, deny } = await harness();
        deny();
        const result = await call("create_artifact", {
            type: "html",
            title: "Denied",
            url: "http://localhost:5173/",
        });
        expect(result.isError).toBe(true);
        expect(reviews).toHaveLength(1);
        expect((await gym.client.listArtifacts()).artifacts).toEqual([]);
        expect(gym.machineConnections).toHaveLength(0);
        expect(gym.errors).toEqual([]);
    });
});
