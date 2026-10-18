import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    AnthropicProvider,
    ClaudeCodeCredential,
    type BaseProvider,
    type BaseSession,
    type SessionEvent,
} from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import type { ConfigModule } from "../../sources/config/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { ScriptedSession } from "../support/ScriptedProvider.js";

it("sanitizes diagnostic paths longest-first at token boundaries but leaves assistant output and codes byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-boundary-"));
    const relativePath = "synthetic-credential-directory";
    let credential: ClaudeCodeCredential | undefined;
    let config: ConfigModule | undefined;
    let session: BaseSession | undefined;
    try {
        vi.spyOn(ClaudeCodeCredential, "tryLoad").mockImplementation(async (options = {}) => {
            credential = Reflect.construct(ClaudeCodeCredential, [
                options.configDir,
            ]) as ClaudeCodeCredential;
            return credential;
        });
        config = await testConfigRootedAt(
            root,
            `
[node]
name = "mac"
[providers]
default_enable = false
[providers.private_account]
type = "claude"
enabled = true
credential_isolation = true
config_dir = "${relativePath}"
`,
        );
        let script: SessionEvent[] = [];
        const prototype: BaseProvider = AnthropicProvider.prototype;
        vi.spyOn(prototype, "session").mockImplementation(
            async (id, options) => new ScriptedSession(id, [script], options),
        );
        const provider = await config.providers.resolve("private_account", "anthropic/sonnet-5-5");
        if (provider === null || credential === undefined)
            throw new Error("Missing native fixture credential.");
        expect(credential).toBeInstanceOf(ClaudeCodeCredential);
        const configured = credential.configDir!;
        const absolute = resolve(configured);
        const host = await config.initialNodeName();
        const ordinary = `The assistant legitimately discusses ${configured} and ${absolute} on ${host}.`;
        const diagnostic = `Paths: ${absolute}; ${configured}. Host: ${host}.\n\nKeep machine, macaroni, mac_OS and xmac byte-identical.`;
        const failure: SessionEvent = {
            type: "done",
            state: "error",
            kind: "unknown",
            message: diagnostic,
            providerError: {
                type: "authentication",
                diagnostics: {
                    status: 401,
                    code: "mac",
                    errorType: "authentication_error",
                    upstreamMessage: diagnostic,
                },
            },
        };
        script = [
            { type: "block_start" },
            { type: "text_start" },
            { type: "text_delta", delta: ordinary },
            { type: "text_end" },
            { type: "retrying", attempt: 1, reason: diagnostic },
            failure,
        ];
        session = await provider.session("conversation", { instructions: "test" });
        const events: SessionEvent[] = [];
        for await (const event of session.run(createRootContext(), {
            context: { instructions: "test", messages: [] },
        }))
            events.push(event);
        expect(events.map((event) => event.type)).toEqual(script.map((event) => event.type));
        expect(events.slice(0, 4)).toEqual(script.slice(0, 4));
        expect(events.at(-1)).toMatchObject({
            providerError: {
                type: "authentication",
                diagnostics: { status: 401, code: "mac", errorType: "authentication_error" },
            },
        });
        const done = events.at(-1);
        if (done?.type !== "done" || done.state !== "error")
            throw new Error("Missing diagnostic event.");
        const retry = events[4];
        if (retry?.type !== "retrying") throw new Error("Missing retry notice.");
        for (const text of [
            done.message,
            done.providerError?.diagnostics?.upstreamMessage,
            retry.reason,
        ]) {
            expect(text).not.toContain(configured);
            expect(text).not.toContain(dirname(absolute));
            expect(text).not.toContain("Host: mac.");
            expect(text).toContain("\n\nKeep machine, macaroni, mac_OS and xmac byte-identical.");
        }
        expect(failure.message).toBe(diagnostic);
    } finally {
        await session?.destroy();
        await config?.closeProviders();
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
    }
});
