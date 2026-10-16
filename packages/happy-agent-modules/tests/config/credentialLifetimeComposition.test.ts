import { AgentProviders } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";

import { CredentialDiagnosticSources } from "../../sources/config/impl/credentialDiagnosticSanitizer.js";
import { providerRegistryUntil } from "../../sources/config/impl/providerRegistryUntil.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

it.each(["privacy-first", "lifetime-first"] as const)(
    "composes both native session boundaries in %s order",
    async (order) => {
        const selector = "providers.selected.api_key";
        let lifetime: AbortSignal | undefined;
        const native = new ScriptedProvider([
            async function* (ctx) {
                lifetime = ctx.lifetime;
                yield {
                    type: "done",
                    state: "error",
                    kind: "unknown",
                    message: `Authentication failed at ${selector}`,
                };
            },
        ]);
        const sources = new CredentialDiagnosticSources("selected", []);
        sources.configured("api_key", "synthetic-key");
        if (order === "privacy-first") sources.snapshot().protect(native);
        const registry = new AgentProviders();
        registry.add("selected", native, "codex");
        const shutdown = new AbortController();
        const validate = vi.fn(async () => {});
        const wrapped = providerRegistryUntil(
            registry,
            shutdown.signal,
            undefined,
            undefined,
            validate,
        );
        const provider = await wrapped.resolve("selected", "openai/gpt-6-astra");
        if (provider === null) throw new Error("Missing fixture provider.");
        if (order === "lifetime-first") sources.snapshot().protect(provider);
        const session = await provider.session("conversation", { instructions: "test" });
        try {
            const events = [];
            for await (const event of session.run(createRootContext(), {
                context: { instructions: "test", messages: [] },
                serviceTier: "ultrafast",
            }))
                events.push(event);
            expect(session).toBe(native.sessions[0]);
            expect(validate).toHaveBeenCalledOnce();
            expect(native.sessions[0]!.requests).toHaveLength(1);
            expect(events).toMatchObject([{ type: "done", state: "error" }]);
            expect(JSON.stringify(events)).not.toContain(selector);
            expect(lifetime?.aborted).toBe(false);
            const reason = new Error("Fixture shutdown.");
            shutdown.abort(reason);
            expect(lifetime?.aborted).toBe(true);
            expect(lifetime?.reason).toBe(reason);
        } finally {
            await session.destroy();
        }
    },
);
