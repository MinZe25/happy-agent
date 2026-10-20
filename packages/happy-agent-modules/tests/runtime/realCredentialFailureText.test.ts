import { createServer } from "node:http";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";

import { diagnosticRuntime } from "../support/diagnosticRuntime.js";
import type { AgentEvent } from "../../sources/events/index.js";

it.each([
    "history and settlement",
    "durable bridge delivery",
    "durable Telegram delivery",
] as const)(
    "cleans a real configured provider's error before %s",
    async (target) => {
        const markers = ["providers.private_account.api_key", hostname()];
        const suffix = "The request was not accepted.\n\nRetry this conversation when ready.";
        const message = `Authentication failed at ${markers.join(" on ")}.\n\n${suffix}`;
        const telegramSent: unknown[] = [];
        let telegramUpdateSent = false;
        const server = createServer(async (request, response) => {
            if (request.url?.startsWith("/bot424242:")) {
                let text = "";
                for await (const chunk of request) text += String(chunk);
                const body = JSON.parse(text || "{}");
                let result: unknown = true;
                if (request.url.endsWith("/getMe"))
                    result = {
                        id: 424242,
                        is_bot: true,
                        first_name: "Diagnostic bot",
                        username: "diagnostic_bot",
                    };
                if (request.url.endsWith("/getUpdates")) {
                    if (telegramUpdateSent) return; // Hold the next long poll until fixture teardown.
                    telegramUpdateSent = true;
                    result = [
                        {
                            update_id: 1,
                            message: {
                                message_id: 1,
                                date: 1_700_000_000,
                                chat: { id: 111, type: "private" },
                                from: { id: 111, is_bot: false, first_name: "Ada" },
                                text: "Exercise the configured provider's failure.",
                            },
                        },
                    ];
                }
                if (request.url.endsWith("/sendMessage")) {
                    telegramSent.push(body);
                    result = { message_id: 2 };
                }
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ ok: true, result }));
                return;
            }
            request.resume();
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { type: "authentication_error", message } }));
        });
        let fixture: Awaited<ReturnType<typeof diagnosticRuntime>> | undefined;
        try {
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (address === null || typeof address === "string")
                throw new Error("Missing fixture port.");
            fixture = await diagnosticRuntime(`
[providers]
default_enable = false
[providers.private_account]
type = "codex"
enabled = true
credential_isolation = true
api_key = "synthetic-fixture-key"
base_url = "http://127.0.0.1:${address.port}/v1"
transport = "sse"
[defaults]
provider = "private_account"
model = "openai/gpt-5.6-sol"
[settings]
inference_max_retries = 0
[telegram]
api_url = "http://127.0.0.1:${address.port}"
`);
            const { runtime, client } = fixture;
            const agent = fixture.agent!;
            if (target === "durable bridge delivery") {
                await expectSafeBridgeDelivery(fixture, markers, suffix);
                return;
            }
            if (target === "durable Telegram delivery") {
                const observed = observePersistedReplies(fixture);
                try {
                    const { bot } = await client.createBot({ name: "Diagnostic Telegram" });
                    await runtime.modules.exportedBots.saveExportedBot(fixture.ctx, agent.id, {
                        botId: bot.id,
                        kind: "telegram",
                        allowedUsers: ["111"],
                        credentials: {
                            account: "424242",
                            settings: { token: `424242:${"t".repeat(32)}` },
                        },
                    });
                    await vi.waitFor(() => expect(telegramSent).toHaveLength(1), {
                        timeout: 10_000,
                        interval: 10,
                    });
                    expect(observed.persisted).toHaveLength(1);
                    for (const value of [observed.persisted, telegramSent]) {
                        const serialized = JSON.stringify(value);
                        for (const marker of markers) expect(serialized).not.toContain(marker);
                        expect(serialized).toContain(JSON.stringify(suffix).slice(1, -1));
                    }
                } finally {
                    observed.spy.mockRestore();
                }
                return;
            }
            const delivered: AgentEvent[] = [];
            const unsubscribe = runtime.modules.events.subscribe((event) => {
                if (event.agentId === agent.id) delivered.push(event);
            });
            try {
                const before = (await client.getEvents()).latestCursor;
                await client.sendMessage(agent.id, {
                    text: "Exercise the real terminal credential failure.",
                    mode: {
                        providerId: "private_account",
                        modelId: "openai/gpt-5.6-sol",
                        effort: "medium",
                        serviceTier: null,
                        permissionMode: "auto",
                    },
                });
                await vi.waitFor(
                    async () => {
                        expect(
                            (await client.getMessages(agent.id)).runs.some(
                                (run) => run.status === "failed",
                            ),
                        ).toBe(true);
                    },
                    { timeout: 10_000, interval: 10 },
                );
                const history = await client.getMessages(agent.id);
                const events = await client.getEvents({ after: before, limit: 1000 });
                const done = delivered.findLast(
                    (event) =>
                        event.agentId === agent.id &&
                        event.type === "provider.event" &&
                        (event.payload as { event?: { type?: string } }).event?.type === "done",
                );
                expect(done?.payload).toMatchObject({
                    event: {
                        type: "done",
                        state: "error",
                        providerError: { type: "authentication", diagnostics: { status: 401 } },
                    },
                });
                const settled = delivered.find(
                    (event) => (event as { type: string }).type === "loop.settled",
                );
                expect(settled).toBeDefined();
                const historyContent = history.runs.flatMap((run) =>
                    run.messages.flatMap((message) => message.content),
                );
                const eventContent = events.events.flatMap((event) =>
                    event.type === "message.created" || event.type === "message.updated"
                        ? event.payload.message.content
                        : [],
                );
                for (const value of [historyContent, eventContent, delivered, settled]) {
                    const serialized = JSON.stringify(value);
                    for (const marker of markers) expect(serialized).not.toContain(marker);
                }
                // The provider's cleaned text still reaches the stream and the settlement; the
                // transcript row shows the typed sign-in failure's own sentence instead.
                for (const value of [delivered, settled])
                    expect(JSON.stringify(value)).toContain(JSON.stringify(suffix).slice(1, -1));
                for (const value of [historyContent, eventContent])
                    expect(value).toContainEqual({
                        type: "text",
                        text: "private_account has no credentials. Check its settings, then retry.",
                    });
            } finally {
                unsubscribe();
            }
        } finally {
            await fixture?.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
    30_000,
);

async function expectSafeBridgeDelivery(
    fixture: Awaited<ReturnType<typeof diagnosticRuntime>>,
    markers: readonly string[],
    suffix: string,
) {
    const { runtime, client, ctx } = fixture;
    const { bot } = await client.createBot({ name: "Diagnostic Scout" });
    const account = "diagnosticbridge";
    const token = `heb1.${account}.${"b".repeat(43)}`;
    await runtime.modules.exportedBots.saveExportedBot(ctx, fixture.agent!.id, {
        botId: bot.id,
        kind: "bridge",
        allowedUsers: ["U-ADA"],
        credentials: {
            account,
            settings: {
                service: "Fixture chat",
                tokenHash: createHash("sha256").update(token).digest("hex"),
            },
        },
    });
    const socket = await runtime.modules.exportedBots.prepareSocket(
        ctx,
        new URL("http://fixture/v0/exported-bots/connect"),
        `Bearer ${token}`,
    );
    if (!socket.handled || !("attach" in socket))
        throw new Error("Fixture bridge was not admitted.");
    const frames: Array<Record<string, unknown>> = [];
    const binding = socket.attach({
        send: (text) => frames.push(JSON.parse(text)),
        close: () => {},
        terminate: () => {},
        ping: () => {},
        bufferedAmount: 0,
    });
    const { spy, persisted } = observePersistedReplies(fixture);
    try {
        await vi.waitFor(() => expect(frames.some((frame) => frame.type === "hello")).toBe(true));
        binding.message(
            JSON.stringify({
                type: "message",
                id: "m1",
                userId: "U-ADA",
                chatId: "D-ADA",
                text: "Exercise the configured provider's failure.",
            }),
        );
        await vi.waitFor(() => expect(frames.some((frame) => frame.type === "reply")).toBe(true), {
            timeout: 10_000,
            interval: 10,
        });
        expect(frames.filter((frame) => frame.type === "ack")).toEqual([{ type: "ack", id: "m1" }]);
        const replies = frames.filter((frame) => frame.type === "reply");
        const rows = await agentDatabaseRows<{ payload: string }>(
            ctx.db,
            sql`SELECT payload FROM happy_agent_module_exported_bot_outbox WHERE account = ${account}`,
        );
        expect(persisted).toHaveLength(1);
        expect(rows).toHaveLength(1);
        for (const value of [persisted, rows.map((row) => JSON.parse(row.payload)), replies]) {
            const serialized = JSON.stringify(value);
            for (const marker of markers) expect(serialized).not.toContain(marker);
            expect(serialized).toContain(JSON.stringify(suffix).slice(1, -1));
        }
    } finally {
        binding.closed();
        spy.mockRestore();
    }
}

function observePersistedReplies(fixture: Awaited<ReturnType<typeof diagnosticRuntime>>) {
    const durable = fixture.runtime.modules.durableFunctions;
    const invoke = durable.invoke.bind(durable);
    const persisted: unknown[] = [];
    // Observe the real persisted payload within its transaction, before dispatch can remove it.
    const spy = vi.spyOn(durable, "invoke").mockImplementation(async (callCtx, input) => {
        const result = await invoke(callCtx, input);
        if (input.function === "exportedBots.reply") {
            const rows = await agentDatabaseRows<{ arguments_json: string }>(
                callCtx.db,
                sql`SELECT arguments_json FROM durable_function_calls WHERE id = ${result.callId}`,
            );
            expect(rows).toHaveLength(1);
            persisted.push(JSON.parse(rows[0]!.arguments_json));
        }
        return result;
    });
    return { spy, persisted };
}
