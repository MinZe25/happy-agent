import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import { acpDiscoverModels } from "@/protocol/acp/acpDiscoverModels.js";
import { foreignAgent } from "@/vendors/foreignAgents/foreignAgents.js";
import type { ForeignAgentType } from "@/vendors/foreignAgents/ForeignAgent.js";

/**
 * Drives each real foreign agent the way Agent Base does: a Happy tool is bridged in, the agent
 * calls it, the response ends with that call, the result is appended, and the run continues the
 * same foreign prompt. A second provider instance then resumes the conversation from disk.
 *
 * Opt in with HAPPY_ACP_LIVE=antigravity,claude-code,codex-cli,acp. HAPPY_ACP_CLAUDE_OAUTH_TOKEN
 * picks a Claude account. The generic `acp` agent starts HAPPY_ACP_GENERIC_COMMAND
 * (space-separated, with the Claude token in CLAUDE_CODE_OAUTH_TOKEN) and uses the first model it
 * reports.
 */
const MODELS: Record<ForeignAgentType, string | undefined> = {
    antigravity: "antigravity/gemini-3.8-flash",
    "claude-code": "claude-code/sonnet",
    "codex-cli": "codex-cli/gpt-6-luna",
    opencode: undefined,
    acp: undefined,
};
const selected = (process.env.HAPPY_ACP_LIVE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is ForeignAgentType => value in MODELS);

describe.skipIf(selected.length === 0)("ACP foreign agents (live)", () => {
    for (const kind of selected) {
        it(`${kind}: runs native tools, calls a bridged Happy tool, and resumes`, async () => {
            const agent = foreignAgent(kind, "live");
            const cwd = mkdtempSync(join(tmpdir(), `acp-${kind}-cwd-`));
            const stateDirectory = mkdtempSync(join(tmpdir(), `acp-${kind}-state-`));
            const token = process.env.HAPPY_ACP_CLAUDE_OAUTH_TOKEN;
            const [command, ...args] = (process.env.HAPPY_ACP_GENERIC_COMMAND ?? "").split(" ");
            const connect = agent.connect(
                kind === "acp"
                    ? {
                          command: command!,
                          args,
                          env: token === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: token },
                      }
                    : {
                          env: agent.credentialEnvironment(
                              kind === "claude-code" && token !== undefined
                                  ? { oauthToken: token }
                                  : {},
                          ),
                      },
            );
            const model =
                MODELS[kind] ??
                agent.modelsFromSelector(await acpDiscoverModels(connect, cwd))[0]?.id;
            expect(model).toBeDefined();
            const provider = () =>
                new AcpProvider({
                    connect,
                    stateDirectory,
                    environment: () => ({ cwd, permissionMode: "full_access" }),
                    profile: agent.profile,
                });
            const tools = [
                {
                    name: "happy_secret",
                    description: "Returns the secret word Happy is holding for this session.",
                    parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
                },
            ];
            const ctx = withLifetime(
                createRootContext().named("acp-live"),
                new AbortController().signal,
            );
            const messages: SessionMessage[] = [];
            const run = async (session: Awaited<ReturnType<AcpProvider["session"]>>) => {
                const events: SessionEvent[] = [];
                const accumulator = new SessionAssistantMessageAccumulator();
                for await (const event of session.run(ctx, {
                    context: { instructions: "You are being tested by Happy.", messages },
                    model: model!,
                })) {
                    events.push(event);
                    accumulator.add(event);
                    // Agent Base stops reading at `done`; nothing may depend on reading past it.
                    if (event.type === "done") break;
                }
                const message = accumulator.message();
                if (message !== undefined) messages.push(message);
                return events;
            };

            const first = await provider().session("agent-1", { instructions: "", tools });
            messages.push({
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Create a file named note.txt containing the word ready using your own tools. Then call the happy_secret tool and reply with only the secret word it returns.",
                    },
                ],
            });
            const toolTurn = await run(first);
            const done = toolTurn.find((event) => event.type === "done");
            expect(done, JSON.stringify(toolTurn.slice(-3))).toMatchObject({ state: "tool_call" });
            const call = toolTurn.find(
                (event) => event.type === "toolcall_start" && event.server !== true,
            );
            expect(call).toMatchObject({ name: "happy_secret" });
            expect(
                toolTurn.some((event) => event.type === "toolcall_start" && event.server === true),
            ).toBe(true);
            messages.push({
                role: "tool",
                callId: (call as { callId: string }).callId,
                content: [{ type: "text", text: "pomegranate" }],
            });
            const answer = await run(first);
            expect(answer.find((event) => event.type === "done")).toMatchObject({
                state: "normal",
            });
            expect(textOf(answer).toLowerCase()).toContain("pomegranate");
            expect(readFileSync(join(cwd, "note.txt"), "utf8")).toContain("ready");
            await first.destroy();

            // A new process continues the same foreign conversation from the stored record.
            const second = await provider().session("agent-1", { instructions: "", tools: [] });
            messages.push({
                role: "user",
                content: [
                    { type: "text", text: "Without tools: what was the secret word? One word." },
                ],
            });
            const resumed = await run(second);
            expect(textOf(resumed).toLowerCase()).toContain("pomegranate");
            await second.destroy();
        }, 600_000);
    }
});

function textOf(events: readonly SessionEvent[]): string {
    return events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");
}
