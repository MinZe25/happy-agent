import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { HappyAgentApiError } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const VALUE = "deleted-secret-gym-value";

describe("deleting a secret through the API", () => {
    it("removes the secret and every grant so agents no longer find it", async () => {
        const commands = new Map<string, GymTurn>();
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            inference: (request): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ type: "text", text: "Secret deletion" }] };
                }
                for (const [callId, turn] of commands) {
                    if (JSON.stringify(request.messages).includes(`request ${callId}`)) {
                        commands.delete(callId);
                        return turn;
                    }
                }
                return { content: [{ type: "text", text: "Settled." }] };
            },
        });
        running.add(gym);
        let index = 0;
        async function referenceSecret(): Promise<string> {
            const callId = `deletion_call_${++index}`;
            commands.set(callId, {
                content: [
                    {
                        type: "tool_call",
                        name: "reference_secret",
                        callId,
                        arguments: { id: "doomed" },
                    },
                ],
            });
            await gym.send(`Look the secret up, request ${callId}.`);
            const result = await gym.waitUntil(
                async () => gym.inference.toolResults().find((item) => item.callId === callId),
                "the secret lookup",
            );
            return JSON.stringify(result);
        }

        const project = (await gym.client.listProjects()).projects[0]!;
        const created = await gym.client.createSecret({
            id: "doomed",
            description: "Credentials about to be deleted",
            environment: { DOOMED_TOKEN: VALUE },
        });
        await gym.client.attachSecret("doomed", { type: "project", id: project.id });
        await gym.client.attachSecret("doomed", { type: "agent", id: gym.defaultSessionId });
        expect(await referenceSecret()).toContain("Credentials about to be deleted");

        const stale: unknown = await gym.client
            .deleteSecret("doomed", undefined, { ifMatch: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e" })
            .catch((error: unknown) => error);
        expect(stale).toBeInstanceOf(HappyAgentApiError);
        expect(stale).toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: created.secret.version, secret: created.secret },
        });
        expect(JSON.stringify((stale as HappyAgentApiError).body)).not.toContain(VALUE);
        await expect(gym.client.getSecret("doomed")).resolves.toEqual(created);

        const before = (await gym.client.getEvents()).latestCursor;
        const deleted = await gym.client.deleteSecret(
            "doomed",
            { mutationId: "delete-doomed" },
            { ifMatch: created.secret.version },
        );
        expect(deleted).toEqual(created);
        expect(JSON.stringify(deleted)).not.toContain(VALUE);

        await expect(gym.client.getSecret("doomed")).rejects.toMatchObject({ status: 404 });
        await expect(gym.client.listSecrets()).resolves.toEqual({
            secrets: [],
            nextCursor: null,
        });
        for (const target of [
            { targetType: "project", targetId: project.id },
            { targetType: "agent", targetId: gym.defaultSessionId },
        ] as const) {
            await expect(gym.client.listSecrets(target)).resolves.toEqual({
                secrets: [],
                nextCursor: null,
            });
        }
        await expect(
            gym.client.deleteSecret("doomed", undefined, { ifMatch: created.secret.version }),
        ).rejects.toMatchObject({ status: 404 });

        const removed = await gym.waitForEvent(
            (event) => event.type === "secret.removed",
            "the secret to be removed",
        );
        expect(removed.payload).toEqual({
            mutationId: "delete-doomed",
            secretId: "doomed",
            previousVersion: created.secret.version,
        });
        const events = (await gym.client.getEvents({ after: before ?? undefined })).events;
        expect(events.filter((event) => event.type.startsWith("secret."))).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain(VALUE);

        const gone = await referenceSecret();
        expect(gone).toContain("That secret reference is not registered.");
        expect(gone).not.toContain(VALUE);
    }, 60_000);
});
