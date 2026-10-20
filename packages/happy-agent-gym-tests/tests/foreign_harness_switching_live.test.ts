import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * One conversation switched between accounts and harnesses mid-session: Claude Code on two
 * accounts, Happy's own loop on the first, and Antigravity. Every leg must know what the others
 * did. An account switched back to keeps its own foreign session; a switch across model families
 * hands the next one Happy's switch summary instead, as it does for Happy's own models. Opt in with
 * HAPPY_ACP_LIVE=switching and two Claude logins in HAPPY_ACP_CLAUDE_OAUTH_TOKEN and
 * HAPPY_ACP_CLAUDE_OAUTH_TOKEN_2; Antigravity uses its own login.
 */
const TURN_MS = 240_000;
const live = (process.env.HAPPY_ACP_LIVE ?? "").split(",").map((v) => v.trim());
const first = process.env.HAPPY_ACP_CLAUDE_OAUTH_TOKEN;
const second = process.env.HAPPY_ACP_CLAUDE_OAUTH_TOKEN_2;

const onA = { providerId: "claude_a", modelId: "claude-code/sonnet", effort: "low" };
const onB = { providerId: "claude_b", modelId: "claude-code/sonnet", effort: "low" };
const happyOnA = { providerId: "claude_a", modelId: "anthropic/sonnet-5-5", effort: "low" };
const antigravity = {
    providerId: "antigravity",
    modelId: "antigravity/gemini-3.8-flash",
    effort: "low",
};

interface Block {
    readonly type: string;
    readonly text?: string;
}

function lastText(history: GymAgentHistory): string {
    return (
        history.runs
            .flatMap((r) => r.messages)
            .flatMap((message) =>
                message.role === "agent" ? (message.content as readonly Block[]) : [],
            )
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .at(-1) ?? ""
    );
}

describe.skipIf(!live.includes("switching") || first === undefined || second === undefined)(
    "switching accounts and harnesses, live",
    () => {
        let gym: AgentGym | undefined;
        afterEach(async ({ task }) => {
            if (gym !== undefined && task.result?.state === "fail") {
                for (const session of await gym.listSessions().catch(() => [])) {
                    const history = await gym.history(session.id).catch(String);
                    console.log(`HISTORY switching ${session.id}`, JSON.stringify(history));
                }
            }
            await gym?.dispose();
            gym = undefined;
        }, 60_000);

        async function record(providerDirectory: readonly string[], agentId: string) {
            return JSON.parse(
                await readFile(
                    join(
                        gym!.happyHome,
                        "agent",
                        "foreign-agents",
                        ...providerDirectory,
                        "sessions",
                        `${encodeURIComponent(agentId)}.json`,
                    ),
                    "utf8",
                ),
            ) as { acpSessionId: string; consumed: number };
        }

        it(
            "carries one conversation across accounts and harnesses and back",
            async () => {
                gym = await createAgentGym({
                    config: [
                        "[providers.claude_a]",
                        'type = "claude"',
                        "enabled = true",
                        `oauth_token = "${first}"`,
                        "[providers.claude_b]",
                        'type = "claude"',
                        "enabled = true",
                        `oauth_token = "${second}"`,
                        "[harnesses.claude_code]",
                        'providers = ["claude_a", "claude_b"]',
                        "[harnesses.antigravity]",
                        "",
                    ].join("\n"),
                    liveProviders: ["claude_a", "claude_b", "antigravity"],
                    permissionMode: "full_access",
                    timeoutMs: TURN_MS,
                });
                const ask = async (text: string, select: typeof onA): Promise<string> => {
                    await gym!.send(text, select);
                    return lastText(await gym!.history());
                };

                await ask(
                    "The codeword is AMBER-3. With your own tools create amber.txt containing " +
                        "AMBER-3, then reply OK.",
                    onA,
                );
                expect((await gym.readFile("amber.txt")).trim()).toBe("AMBER-3");
                const aBefore = await record(["claude_code", "claude_a"], gym.defaultSessionId);

                // Another account mid-session: a fresh foreign session that is handed the story.
                expect(
                    await ask(
                        "Which codeword did I give you and which file holds it? Reply as CODEWORD FILE.",
                        onB,
                    ),
                ).toMatch(/AMBER-3[\s\S]*amber\.txt/u);
                await ask(
                    "The codeword is now BIRCH-8. Create birch.txt containing BIRCH-8 with your own " +
                        "tools, then reply OK.",
                    onB,
                );
                expect((await gym.readFile("birch.txt")).trim()).toBe("BIRCH-8");
                const b = await record(["claude_code", "claude_b"], gym.defaultSessionId);
                expect(b.acpSessionId).not.toBe(aBefore.acpSessionId);

                // Back on the first account: the same foreign session, caught up on the other.
                expect(
                    await ask(
                        "What is the codeword now, and which files exist with codewords? Reply as " +
                            "CODEWORD then the files.",
                        onA,
                    ),
                ).toMatch(/BIRCH-8[\s\S]*birch\.txt/u);
                const aAfter = await record(["claude_code", "claude_a"], gym.defaultSessionId);
                expect(aAfter.acpSessionId).toBe(aBefore.acpSessionId);

                // Happy's own loop on the same account reads a transcript the foreign agent wrote.
                expect(
                    await ask("What is the codeword now? Reply with only the codeword.", happyOnA),
                ).toContain("BIRCH-8");
                await ask(
                    "The codeword is now CEDAR-5. Reply with only OK; do not create any file.",
                    happyOnA,
                );

                // A different harness, then back to Claude Code.
                expect(
                    await ask(
                        "What is the codeword now? Create cedar.txt containing it with your own " +
                            "tools, then reply with only the codeword.",
                        antigravity,
                    ),
                ).toContain("CEDAR-5");
                expect((await gym.readFile("cedar.txt")).trim()).toBe("CEDAR-5");
                expect(
                    await ask(
                        "List every codeword so far in order, separated by spaces, and nothing else.",
                        onA,
                    ),
                ).toMatch(/AMBER-3[\s\S]*BIRCH-8[\s\S]*CEDAR-5/u);

                // A new conversation on the second account starts clean.
                const fresh = await gym.createSession({ title: "Fresh" });
                await gym.send(
                    "Have I given you a codeword in this conversation? Reply only YES or NO.",
                    { ...onB, sessionId: fresh.id },
                );
                const answer = lastText(await gym.history(fresh.id));
                expect(answer).toContain("NO");
                expect(answer).not.toMatch(/AMBER|BIRCH|CEDAR/u);
                const freshRecord = await record(["claude_code", "claude_b"], fresh.id);
                expect(freshRecord.acpSessionId).not.toBe(b.acpSessionId);
                expect(gym.errors).toEqual([]);
            },
            TURN_MS * 10,
        );
    },
);
