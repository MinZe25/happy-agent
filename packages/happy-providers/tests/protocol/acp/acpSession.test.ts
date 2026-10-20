import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@sinclair/typebox";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import {
    AcpProvider,
    type AcpAgentProfile,
    type AcpPermissionMode,
} from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { acpDiscoverModels } from "@/protocol/acp/acpDiscoverModels.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import type * as acp from "@agentclientprotocol/sdk";
import { acpConfigOptionId } from "@/protocol/acp/impl/acpConfigOptions.js";
import { acpGenericAgent } from "@/vendors/foreignAgents/acpGenericAgent.js";
import { antigravityAgent } from "@/vendors/foreignAgents/antigravityAgent.js";

const AGENT = fileURLToPath(new URL("./fixtures/scriptedAcpAgent.mjs", import.meta.url));
const tools = [
    {
        name: "happy_secret",
        description: "Returns the secret.",
        parameters: Type.Object({ why: Type.Optional(Type.String()) }),
    },
];

const open: AcpSession[] = [];
afterEach(async () => {
    await Promise.all(open.splice(0).map((session) => session.destroy()));
});

function harness(options: { steerable?: boolean; profile?: AcpAgentProfile } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "acp-session-"));
    const logPath = join(directory, "agent.jsonl");
    let permissionMode: AcpPermissionMode = "auto";
    const launch = {
        command: process.execPath,
        args: [AGENT],
        env: { SCRIPTED_ACP_LOG: logPath },
    };
    const provider = new AcpProvider({
        launch,
        // A first-party driver offers mid-turn input; the fixture stands in for it over ACP.
        ...(options.steerable === true
            ? {
                  connect: async (cwd: string, client: acp.Client) => {
                      const connection = await acpConnectionSpawn(launch, cwd, client);
                      const conn = connection.conn as acp.ClientSideConnection;
                      return {
                          ...connection,
                          conn: Object.assign(Object.create(conn) as typeof conn, {
                              steer: async (params: {
                                  sessionId: string;
                                  prompt: acp.ContentBlock[];
                              }) =>
                                  (
                                      await conn.extMethod("_happy/steer", {
                                          sessionId: params.sessionId,
                                          text: params.prompt
                                              .map((b) => (b.type === "text" ? b.text : ""))
                                              .join(""),
                                      })
                                  ).taken === true,
                          }),
                      };
                  },
              }
            : {}),
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode }),
        profile: options.profile ?? {
            modelOptions: (model) =>
                model === undefined ? [] : [{ configId: "model", value: model }],
            permissionOptions: (mode) => [{ configId: "mode", value: mode }],
        },
    });
    const messages: SessionMessage[] = [];
    return {
        messages,
        setPermissionMode: (mode: AcpPermissionMode) => {
            permissionMode = mode;
        },
        log: (): Record<string, unknown>[] =>
            readFileSync(logPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>),
        async session(): Promise<AcpSession> {
            const session = await provider.session("agent-1", { instructions: "Be Happy.", tools });
            open.push(session);
            return session;
        },
        user(text: string): void {
            messages.push({ role: "user", content: [{ type: "text", text }] });
        },
        /** Consume one response exactly as Agent Base does: stop reading at `done`. */
        async run(
            session: AcpSession,
            signal?: AbortSignal,
            steered?: AbortSignal,
        ): Promise<SessionEvent[]> {
            const events: SessionEvent[] = [];
            const accumulator = new SessionAssistantMessageAccumulator();
            const ctx = withLifetime(
                createRootContext().named("acp-test"),
                signal ?? new AbortController().signal,
            );
            for await (const event of session.run(ctx, {
                context: { instructions: "Be Happy.", messages },
                model: "m1",
                ...(steered === undefined ? {} : { steered }),
            })) {
                events.push(event);
                accumulator.add(event);
                if (event.type === "done") break;
            }
            const message = accumulator.message();
            if (message !== undefined) messages.push(message);
            return events;
        },
    };
}

const text = (events: readonly SessionEvent[]) =>
    events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");
const done = (events: readonly SessionEvent[]) => events.find((event) => event.type === "done");

describe("AcpSession", () => {
    it("reports the agent's own tools as settled provider calls", async () => {
        const h = harness();
        const session = await h.session();
        h.user("hello");
        const events = await h.run(session);
        const start = events.find((event) => event.type === "toolcall_start");
        expect(start).toMatchObject({ name: "read", server: true });
        expect(events.some((event) => event.type === "toolcall_result_end")).toBe(true);
        expect(done(events)).toMatchObject({ state: "normal", endTurn: true });
        expect(h.messages.at(-1)).toMatchObject({ role: "assistant" });
    }, 30_000);

    it("ends the response with a bridged Happy tool call and resumes the same prompt with its result", async () => {
        const h = harness();
        const session = await h.session();
        h.user("please use happy");
        const first = await h.run(session);
        expect(done(first)).toMatchObject({ state: "tool_call" });
        const call = first.find(
            (event): event is Extract<SessionEvent, { type: "toolcall_start" }> =>
                event.type === "toolcall_start" && event.server !== true,
        );
        expect(call).toMatchObject({ name: "happy_secret" });
        expect(
            first.find((event) => event.type === "toolcall_end" && event.callId === call!.callId),
        ).toMatchObject({ arguments: JSON.stringify({ why: "test" }) });

        h.messages.push({
            role: "tool",
            callId: call!.callId,
            content: [{ type: "text", text: "pomegranate" }],
        });
        const second = await h.run(session);
        expect(text(second)).toBe("secret=pomegranate");
        expect(done(second)).toMatchObject({ state: "normal" });
        // One foreign prompt served both Happy responses.
        expect(h.log().filter((entry) => entry.method === "prompt")).toHaveLength(1);
        expect(h.log().find((entry) => entry.method === "mcp.listTools")).toMatchObject({
            names: ["happy_secret"],
        });
    }, 30_000);

    it("sends a fresh session Happy's instructions, then only new input on later turns", async () => {
        const h = harness();
        const session = await h.session();
        h.user("first");
        await h.run(session);
        h.user("second");
        await h.run(session);
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        expect(prompts[0]!.text).toContain("<happy-instructions>\nBe Happy.");
        expect(prompts[1]!.text).toBe("second");
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("continues the stored foreign session from a new process without replaying its history", async () => {
        const h = harness();
        const first = await h.session();
        h.user("first");
        await h.run(first);
        await first.destroy();

        const second = await h.session();
        h.user("after restart");
        const events = await h.run(second);
        expect(text(events)).toBe("echo:after restart");
        expect(text(events)).not.toContain("REPLAYED-HISTORY");
        expect(h.log().filter((entry) => entry.method === "loadSession")).toHaveLength(1);
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("replays Happy's transcript into a new session when the history no longer matches", async () => {
        const h = harness();
        const session = await h.session();
        h.user("original question");
        await h.run(session);
        // A compaction or an edit replaces what the foreign session saw.
        h.messages.splice(0, h.messages.length);
        h.user("summary of earlier work");
        h.messages.push({ role: "assistant", content: [{ type: "text", text: "noted" }] });
        h.user("continue");
        const events = await h.run(session);
        expect(text(events)).toContain("<conversation-so-far>");
        expect(text(events)).toContain("User: summary of earlier work");
        expect(text(events)).toContain("Assistant: noted");
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(2);
    }, 30_000);

    it("catches a session up on turns another account or harness answered, keeping the session", async () => {
        const h = harness();
        const session = await h.session();
        h.user("first");
        await h.run(session);
        // The conversation switched elsewhere for a turn, then came back.
        h.user("second");
        h.messages.push({ role: "assistant", content: [{ type: "text", text: "from elsewhere" }] });
        h.user("third");
        await h.run(session);
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        expect(prompts[1]!.text).toContain("<conversation-elsewhere>");
        expect(prompts[1]!.text).toContain("User: second");
        expect(prompts[1]!.text).toContain("Assistant: from elsewhere");
        expect(prompts[1]!.text).not.toContain("echo:first");
        expect(String(prompts[1]!.text).endsWith("third")).toBe(true);
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("maps the model and permission mode onto config options, setting each only when it changes", async () => {
        const h = harness();
        const session = await h.session();
        h.user("one");
        await h.run(session);
        h.user("two");
        await h.run(session);
        h.setPermissionMode("read_only");
        h.user("three");
        await h.run(session);
        const options = h
            .log()
            .filter((entry) => entry.method === "setSessionConfigOption")
            .map((entry) => `${String(entry.configId)}=${String(entry.value)}`);
        expect(options).toEqual(["model=m1", "mode=auto", "mode=read_only"]);
    }, 30_000);

    it("interrupts the foreign turn on steering and sends only the steering next", async () => {
        const h = harness();
        const session = await h.session();
        h.user("wait for me");
        const steering = new AbortController();
        const running = h.run(session, undefined, steering.signal);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        steering.abort();
        // A normal end keeps Agent Base's loop going, so it injects the steering and asks again.
        expect(done(await running)).toMatchObject({ state: "normal" });

        h.user("change of plan");
        expect(text(await h.run(session))).toBe("echo:change of plan");
        const prompts = h.log().filter((entry) => entry.method === "prompt");
        expect(prompts.at(-1)).toMatchObject({ text: "change of plan" });
        expect(h.log().filter((entry) => entry.method === "newSession")).toHaveLength(1);
    }, 30_000);

    it("hands steering to an agent that takes input mid-turn without stopping it", async () => {
        const h = harness({ steerable: true });
        const session = await h.session();
        h.user("wait for me");
        const steering = new AbortController();
        const running = h.run(session, undefined, steering.signal);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        steering.abort();
        expect(done(await running)).toMatchObject({ state: "normal" });

        h.user("change of plan");
        expect(text(await h.run(session))).toBe("steered:change of plan");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "cancel")).toHaveLength(0);
        expect(log.filter((entry) => entry.method === "prompt")).toHaveLength(1);
        expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
    }, 30_000);

    it("stops the agent process when the consumer stops reading, as Agent Base does on abort", async () => {
        const h = harness();
        const session = await h.session();
        h.user("wait for me");
        const stream = session
            .run(createRootContext().named("acp-test"), {
                context: { instructions: "Be Happy.", messages: h.messages },
                model: "m1",
            })
            [Symbol.asyncIterator]();
        await stream.next();
        const pending = stream.next();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        void pending.catch(() => undefined);
        await stream.return?.(undefined);

        h.user("next");
        expect(text(await h.run(session))).toBe("echo:next");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "cancel")).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(1);
        expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
        expect(log.filter((entry) => entry.method === "prompt").at(-1)).toMatchObject({
            text: "next",
        });
    }, 30_000);

    it("stops the agent process on abort and continues the same session from a new one", async () => {
        const h = harness();
        const session = await h.session();
        h.user("wait for me");
        const controller = new AbortController();
        const running = h.run(session, controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        controller.abort();
        expect(done(await running)).toMatchObject({ state: "cancelled" });

        // The stopped request is not repeated: the new process restores the session and is sent
        // only what arrived after the stop.
        h.user("next");
        expect(text(await h.run(session))).toBe("echo:next");
        const log = h.log();
        expect(log.filter((entry) => entry.method === "cancel")).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "newSession")).toHaveLength(1);
        expect(log.filter((entry) => entry.method === "loadSession")).toHaveLength(1);
        expect(new Set(log.map((entry) => entry.pid)).size).toBe(2);
        expect(log.filter((entry) => entry.method === "prompt").at(-1)).toMatchObject({
            text: "next",
        });
    }, 30_000);

    it("reads the models an agent serves from its model selector", async () => {
        const directory = mkdtempSync(join(tmpdir(), "acp-discover-"));
        const values = await acpDiscoverModels(
            {
                command: process.execPath,
                args: [AGENT],
                env: { SCRIPTED_ACP_LOG: join(directory, "agent.jsonl") },
            },
            directory,
        );
        expect(values).toEqual([
            { value: "m1", name: "Model One" },
            { value: "m2-high", name: "Model Two (High)" },
        ]);
        expect(
            antigravityAgent.modelsFromSelector([
                { value: "gemini-9-low", name: "Gemini 9 (Low)" },
                { value: "gemini-9-high", name: "Gemini 9 (High)" },
                { value: "oss-1", name: "OSS One" },
            ]),
        ).toEqual([
            expect.objectContaining({
                id: "antigravity/gemini-9",
                name: "Gemini 9",
                effortLevels: ["low", "high"],
                defaultEffort: "low",
            }),
            expect.objectContaining({ id: "antigravity/oss-1", effortLevels: ["medium"] }),
        ]);
    }, 30_000);

    it("lets the next new session start when one that never bound its conversation is stopped", async () => {
        // One profile object, as every account of one agent shares in a daemon.
        const profile: AcpAgentProfile = { serializeNewSessions: true };
        const silent = harness({ profile });
        const next = harness({ profile });
        const first = await silent.session();
        silent.user("silent wait");
        const stop = new AbortController();
        const stopped = silent.run(first, stop.signal);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        stop.abort();
        await stopped;

        const second = await next.session();
        next.user("hello");
        const startedAt = Date.now();
        expect(text(await next.run(second))).toMatch(/hello$/u);
        expect(Date.now() - startedAt).toBeLessThan(10_000);
    }, 30_000);

    it("drives any ACP agent from its command, offering and selecting the models it reports", async () => {
        const directory = mkdtempSync(join(tmpdir(), "acp-generic-"));
        const logPath = join(directory, "agent.jsonl");
        const agent = acpGenericAgent("scripted");
        const connect = agent.connect({
            command: process.execPath,
            args: [AGENT],
            env: { SCRIPTED_ACP_LOG: logPath },
        });
        const models = agent.modelsFromSelector(await acpDiscoverModels(connect, directory));
        expect(models.map((model) => model.id)).toEqual([
            "acp/scripted/m1",
            "acp/scripted/m2-high",
        ]);

        const provider = new AcpProvider({
            connect,
            stateDirectory: join(directory, "state"),
            environment: () => ({ cwd: directory, permissionMode: "auto" }),
            profile: agent.profile,
        });
        const session = await provider.session("agent-1", { instructions: "", tools: [] });
        open.push(session);
        const ctx = withLifetime(
            createRootContext().named("acp-test"),
            new AbortController().signal,
        );
        for await (const event of session.run(ctx, {
            context: {
                instructions: "",
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            },
            model: "acp/scripted/m2-high",
        })) {
            if (event.type === "done") break;
        }
        const options = readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((entry) => entry.method === "setSessionConfigOption");
        expect(options).toEqual([expect.objectContaining({ configId: "model", value: "m2-high" })]);
    }, 30_000);

    it("sets an option wanted by category on whatever the agent calls it", () => {
        const advertised = [
            {
                id: "llm",
                name: "LLM",
                category: "model",
                type: "select",
                currentValue: "a",
                options: [{ value: "a", name: "A" }],
            },
        ] as acp.SessionConfigOption[];
        expect(
            acpConfigOptionId(advertised, { configId: "model", category: "model", value: "a" }),
        ).toBe("llm");
        expect(
            acpConfigOptionId([], { configId: "model", category: "model", value: "a" }),
        ).toBeUndefined();
        expect(acpConfigOptionId([], { configId: "mode", value: "plan" })).toBe("mode");
    });
});
