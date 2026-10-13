import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    credentialSourceSchema,
    errorRecoveryCommandSchema,
    errorRecoverySchema,
    HappyAgentClient,
    knownCredentialSourceKindSchema,
    knownErrorRecoveryActionSchema,
    messageErrorSchema,
    type MessageError,
    type MessageHistoryResponse,
    type ServiceMessage,
} from "../sources/index.js";

const error: MessageError = {
    code: "authentication",
    mode: {
        account: { id: "work", label: "Work" },
        effort: "high",
        modelId: "anthropic/opus-5-5",
        permissionMode: "auto",
        providerId: "claude_work",
        providerType: "claude",
        serviceTier: null,
    },
    credentialSource: {
        kind: "environment",
        location: "CLAUDE_CODE_OAUTH_TOKEN",
        host: "Mac mini",
    },
    recovery: {
        steps: ["Replace the token in the daemon environment, then reload that environment."],
        actions: ["ask_chief"],
    },
};

describe("message error details", () => {
    it("describes actual failed execution separately from the full display text", () => {
        expect(Value.Check(messageErrorSchema, error)).toBe(true);
        expect(
            Value.Check(messageErrorSchema, {
                ...error,
                code: "future_failure_code",
                mode: null,
                credentialSource: null,
                futureDetail: true,
            }),
        ).toBe(true);
        expect(Value.Check(messageErrorSchema, { ...error, code: "" })).toBe(false);
        expect(Value.Check(messageErrorSchema, { ...error, code: "x".repeat(129) })).toBe(false);
        expect(Value.Check(messageErrorSchema, { ...error, mode: {} })).toBe(false);
    });

    it.each(["native_login", "configuration", "environment"])(
        "supports the %s descriptor with a withheld host",
        (kind) => {
            expect(
                Value.Check(credentialSourceSchema, {
                    kind,
                    location: "Sign-in source",
                    host: null,
                }),
            ).toBe(true);
        },
    );

    it("bounds source descriptions without rejecting a future source kind", () => {
        expect(
            Value.Check(credentialSourceSchema, {
                ...error.credentialSource,
                kind: "future_source",
            }),
        ).toBe(true);
        expect(Value.Check(knownCredentialSourceKindSchema, "future_source")).toBe(false);
        expect(Value.Check(knownCredentialSourceKindSchema, "environment")).toBe(true);
        expect(
            Value.Check(credentialSourceSchema, {
                ...error.credentialSource,
                kind: "x".repeat(65),
            }),
        ).toBe(false);
        expect(
            Value.Check(credentialSourceSchema, { ...error.credentialSource, location: "" }),
        ).toBe(false);
        expect(
            Value.Check(credentialSourceSchema, {
                ...error.credentialSource,
                location: "x".repeat(257),
            }),
        ).toBe(false);
        expect(
            Value.Check(credentialSourceSchema, {
                ...error.credentialSource,
                host: "x".repeat(257),
            }),
        ).toBe(false);
    });

    it("keeps wire actions extensible and bounded, with a separate closed known allowlist", () => {
        expect(Value.Check(errorRecoverySchema, { steps: [], actions: [] })).toBe(true);
        expect(
            Value.Check(errorRecoverySchema, {
                steps: Array(8).fill("x".repeat(2_048)),
                actions: ["ask_chief"],
            }),
        ).toBe(true);
        expect(
            Value.Check(errorRecoverySchema, {
                steps: [],
                actions: ["ask_chief", "future_action"],
            }),
        ).toBe(true);
        expect(Value.Check(knownErrorRecoveryActionSchema, "future_action")).toBe(false);
        expect(Value.Check(knownErrorRecoveryActionSchema, "compact")).toBe(false);
        expect(Value.Check(knownErrorRecoveryActionSchema, "ask_chief")).toBe(true);
        for (const recovery of [
            { steps: Array(9).fill("step"), actions: [] },
            { steps: ["x".repeat(2_049)], actions: [] },
            { steps: [""], actions: [] },
            { steps: [], actions: ["x".repeat(65)] },
            { steps: [], actions: Array.from({ length: 9 }, (_, index) => `action_${index}`) },
            { steps: [], actions: ["ask_chief", "ask_chief"] },
        ]) {
            expect(Value.Check(errorRecoverySchema, recovery)).toBe(false);
        }
    });

    it("bounds optional copyable commands without making them executable actions", () => {
        const command = { label: "Sign in to Claude Code", command: "claude auth login" };
        expect(Value.Check(errorRecoveryCommandSchema, command)).toBe(true);
        expect(
            Value.Check(errorRecoveryCommandSchema, {
                label: "x".repeat(128),
                command: "x".repeat(2_048),
                future: true,
            }),
        ).toBe(true);
        expect(
            Value.Check(errorRecoverySchema, {
                steps: [],
                actions: [],
                commands: Array(8).fill(command),
            }),
        ).toBe(true);
        for (const invalidCommand of [
            { ...command, label: "" },
            { ...command, command: "" },
            { ...command, label: "x".repeat(129) },
            { ...command, command: "x".repeat(2_049) },
            { label: command.label },
            command.command,
        ]) {
            expect(Value.Check(errorRecoveryCommandSchema, invalidCommand)).toBe(false);
        }
        expect(
            Value.Check(errorRecoverySchema, {
                steps: [],
                actions: [],
                commands: Array(9).fill(command),
            }),
        ).toBe(false);
        expect(Value.Check(knownErrorRecoveryActionSchema, command.command)).toBe(false);
    });

    it("carries conditional native-login recovery independently of an AI action", () => {
        const nativeError: MessageError = {
            ...error,
            mode: { ...error.mode!, providerId: "claude", account: null },
            credentialSource: {
                kind: "native_login",
                location: "Claude Code sign-in (default configuration)",
                host: "Agent host",
            },
            recovery: {
                steps: [
                    "Retry this chat first.",
                    "If it still fails, run the sign-in command on Agent host as the same operating-system user that runs the agent, complete browser sign-in, then retry this chat.",
                ],
                actions: [],
                commands: [{ label: "Sign in to Claude Code", command: "claude auth login" }],
            },
        };
        expect(Value.Check(messageErrorSchema, nativeError)).toBe(true);
        expect(nativeError.mode?.account).toBeNull();
        expect(nativeError.recovery.actions).toEqual([]);
        expect(error.recovery.commands).toBeUndefined();
    });

    it("preserves full multiline history text and optional details without reinterpretation", async () => {
        const text = `Authentication failed\n\n401 OAuth access token has expired.\n\n${"Detail. ".repeat(600)}`;
        const message: ServiceMessage = {
            id: "failure",
            role: "service",
            createdAt: 1,
            metadata: {},
            content: [{ type: "text", text }],
            error,
        };
        const oldMessage: ServiceMessage = {
            id: "older-failure",
            role: "service",
            createdAt: 0,
            metadata: {},
            content: [{ type: "text", text: "Earlier error\nSecond line" }],
        };
        const response: MessageHistoryResponse = {
            cursor: "cursor",
            hasMore: false,
            runs: [
                {
                    id: "run",
                    status: "failed",
                    reason: "error",
                    startedAt: 0,
                    endedAt: 1,
                    costUsd: null,
                    usage: {},
                    messages: [oldMessage, message],
                },
            ],
        };
        const fetch: typeof globalThis.fetch = async () => Response.json(response);
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        await expect(client.getMessages("agent")).resolves.toEqual(response);
    });
});
