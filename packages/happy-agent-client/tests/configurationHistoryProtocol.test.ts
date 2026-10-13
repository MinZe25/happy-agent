import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    configurationBlockSchema,
    HappyAgentClient,
    messageAccountSchema,
    messageModeSchema,
    type ConfigurationMessage,
    type HappyAgentEvent,
    type MessageMode,
} from "../sources/index.js";

const mode: MessageMode = {
    effort: "high",
    modelId: "openai/gpt-6-astra",
    permissionMode: "auto",
    providerId: "codex",
    serviceTier: null,
};

describe("configuration history protocol", () => {
    it("keeps older modes valid and distinguishes unknown from known account provenance", () => {
        expect(Value.Check(messageModeSchema, mode)).toBe(true);
        expect(Value.Check(messageModeSchema, { ...mode, account: null })).toBe(true);
        expect(Value.Check(messageModeSchema, { ...mode, account: { id: "local-account" } })).toBe(
            true,
        );
        expect(
            Value.Check(messageModeSchema, {
                ...mode,
                account: { id: "local-account", label: "Work" },
            }),
        ).toBe(true);
        expect(Value.Check(messageModeSchema, { ...mode, account: {} })).toBe(false);
    });

    it("bounds account identity and optional label without rejecting future fields", () => {
        expect(Value.Check(messageAccountSchema, { id: "a".repeat(256) })).toBe(true);
        expect(Value.Check(messageAccountSchema, { id: "" })).toBe(false);
        expect(Value.Check(messageAccountSchema, { id: "a".repeat(257) })).toBe(false);
        expect(Value.Check(messageAccountSchema, { id: "a", label: "" })).toBe(false);
        expect(Value.Check(messageAccountSchema, { id: "a", label: "w".repeat(257) })).toBe(false);
        expect(Value.Check(messageAccountSchema, { id: "a", future: true })).toBe(true);
    });

    it("captures a bounded provider family without depending on today's catalog", () => {
        for (const providerType of ["claude", "bedrock", "future_family", "x".repeat(128)]) {
            expect(Value.Check(messageModeSchema, { ...mode, providerType })).toBe(true);
        }
        for (const providerType of ["", "x".repeat(129), null]) {
            expect(Value.Check(messageModeSchema, { ...mode, providerType })).toBe(false);
        }
    });

    it.each([null, { id: "work", label: "Work" }])(
        "does not send server-resolved account %j or provider family back as a selection",
        async (account) => {
            const observedMode = Object.freeze({ ...mode, account, providerType: "codex" });
            const bodies: unknown[] = [];
            const fetch: typeof globalThis.fetch = async (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return Response.json({});
            };
            const client = new HappyAgentClient({
                endpoint: "http://agent.local",
                token: "t",
                fetch,
            });
            await client.sendMessage("agent", { text: "Continue", mode: observedMode });
            await client.invokeSlashCommand("agent", "review", { mode: observedMode });
            const draft = Object.freeze({ ...observedMode, text: "My draft" });
            await client.saveAgentDraft("agent", { draft, updatedAt: 7 });
            await client.saveAgentDraft("agent", { draft: null });
            expect(bodies).toEqual([
                { text: "Continue", mode },
                { mode },
                { draft: { ...mode, text: "My draft" }, updatedAt: 7 },
                { draft: null },
            ]);
            expect(observedMode.account).toBe(account);
            expect(draft.account).toBe(account);
            expect(observedMode.providerType).toBe("codex");
            expect(draft.providerType).toBe("codex");
        },
    );

    it("preserves provenance-shaped keys in opaque user-setting values", async () => {
        const value = Object.freeze({
            account: "A preference, not execution provenance",
            providerType: "An application-owned value",
            nested: Object.freeze({ ...mode, account: null, providerType: "claude" }),
        });
        const request = Object.freeze({ value, updatedAt: 7 });
        const bodies: unknown[] = [];
        const fetch: typeof globalThis.fetch = async (_input, init) => {
            bodies.push(init?.body);
            return Response.json({});
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.saveUserSetting("happy-desktop.preferences", request);

        expect(bodies).toEqual([JSON.stringify(request)]);
        expect(value.nested.account).toBeNull();
        expect(value.nested.providerType).toBe("claude");
    });

    it("describes the hidden initial baseline and a complete before/after transition", () => {
        const initial = {
            type: "configuration",
            before: null,
            after: mode,
            beforeMessageId: "first-message",
        };
        expect(Value.Check(configurationBlockSchema, initial)).toBe(true);
        expect(Value.Check(configurationBlockSchema, { ...initial, beforeMessageId: null })).toBe(
            true,
        );
        expect(
            Value.Check(configurationBlockSchema, {
                ...initial,
                before: mode,
                after: { ...mode, account: { id: "work" } },
            }),
        ).toBe(true);
        expect(Value.Check(configurationBlockSchema, { ...initial, after: null })).toBe(false);
        expect(Value.Check(configurationBlockSchema, { ...initial, after: {} })).toBe(false);
        expect(
            Value.Check(configurationBlockSchema, {
                type: "configuration",
                before: null,
                after: mode,
            }),
        ).toBe(false);
    });

    it("keeps an unanchored mid-run execution change at its append position", () => {
        expect(
            Value.Check(configurationBlockSchema, {
                type: "configuration",
                before: mode,
                after: { ...mode, providerId: "codex_work", account: { id: "work" } },
                beforeMessageId: null,
            }),
        ).toBe(true);
    });

    it("preserves a concrete connection change when both vendor account identities are unknown", () => {
        const block = {
            type: "configuration",
            before: { ...mode, providerId: "claude", providerType: "claude", account: null },
            after: { ...mode, providerId: "claude_extra", providerType: "claude", account: null },
            beforeMessageId: null,
        };
        expect(Value.Check(configurationBlockSchema, block)).toBe(true);
        expect(block.before.providerId).not.toBe(block.after.providerId);
        expect(block.before.account).toBeNull();
        expect(block.after.account).toBeNull();
    });

    it("uses ordinary message transport and the existing message identity for its anchor", () => {
        const message: ConfigurationMessage = {
            id: "configuration-record",
            role: "service",
            createdAt: 1,
            metadata: {},
            content: [
                {
                    type: "configuration",
                    before: mode,
                    after: { ...mode, account: { id: "work", label: "Work" } },
                    beforeMessageId: "affected-message",
                },
            ],
        };
        const event: HappyAgentEvent = {
            cursor: "cursor",
            occurredAt: 1,
            type: "message.created",
            payload: { agentId: "agent", runId: "run", message },
        };
        expect(event.payload.message).toBe(message);
        expect(message.content[0].beforeMessageId).toBe("affected-message");
    });
});
