import { CodexProvider, type BaseProvider, type BaseSession } from "@slopus/happy-providers";
import { expect, it, vi } from "vitest";
import { createRootContext } from "@steve.kite/stdlib";
import { ScriptedSession, ScriptedProvider } from "../support/ScriptedProvider.js";
import { CredentialDiagnosticSources } from "../../sources/config/impl/credentialDiagnosticSanitizer.js";
import { credentialWriterRuntime, writerMode } from "../support/credentialWriterRuntime.js";

it("defends against an injected provider that shares sessions across different credential snapshots", async () => {
    const firstSelector = "providers.private_account.api_key";
    const secondSelector = "providers.other_account.api_key";
    const instances = new Set<BaseProvider>();
    let cached: BaseSession | undefined;
    const prototype: BaseProvider = CodexProvider.prototype;
    // Published native providers always construct fresh sessions. Inject a caching adapter
    // through the real agentProviders/createProvider/protect path as defense in depth.
    vi.spyOn(prototype, "session").mockImplementation(
        async function (this: BaseProvider, id, options) {
            instances.add(this);
            cached ??= new ScriptedSession(
                id,
                [
                    [
                        {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: `First failure at ${firstSelector}`,
                            providerError: { type: "authentication" },
                        },
                    ],
                    [
                        {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: `Equal snapshot failure at ${firstSelector}`,
                            providerError: { type: "authentication" },
                        },
                    ],
                    [
                        {
                            type: "retrying",
                            attempt: 1,
                            reason: `Later retry at ${secondSelector}`,
                        },
                        {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: `Later failure at ${firstSelector} and ${secondSelector}`,
                            providerError: {
                                type: "authentication",
                                diagnostics: {
                                    upstreamMessage: `Later diagnostic at ${secondSelector}`,
                                },
                            },
                        },
                    ],
                    [
                        {
                            type: "done",
                            state: "error",
                            kind: "unknown",
                            message: `Original decorator failure at ${secondSelector}`,
                            providerError: { type: "authentication" },
                        },
                    ],
                    async function* () {
                        yield { type: "block_start" };
                        const error = Object.assign(
                            new Error(`Thrown failure at ${secondSelector}`, {
                                cause: new Error(`Cause at ${firstSelector}`),
                            }),
                            {
                                diagnostics: {
                                    upstreamMessage: `Thrown diagnostic at ${secondSelector}`,
                                },
                            },
                        );
                        error.stack = `Error at ${secondSelector}\n  fixture at ${firstSelector}`;
                        throw error;
                    },
                ],
                options,
            );
            return cached;
        },
    );
    const fixture = await credentialWriterRuntime("owner", {
        providerConfiguration: `[providers]\ndefault_enable = false\n[providers.private_account]\ntype = "codex"\nenabled = true\ncredential_isolation = true\napi_key = "synthetic-first-secret"\n[providers.other_account]\ntype = "codex"\nenabled = true\ncredential_isolation = true\napi_key = "synthetic-later-secret"\n`,
    });
    const observed: unknown[] = [];
    const stop = fixture.runtime.modules.events.subscribe((event) => {
        if (event.agentId === fixture.agent.id) observed.push(event);
    });
    try {
        const first = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "First source.",
            mode: writerMode,
        });
        await vi.waitFor(
            async () =>
                expect(
                    (await fixture.owner.getMessages(fixture.agent.id)).runs.some(
                        (run) =>
                            run.status === "failed" &&
                            run.messages.some((message) => message.id === first.message.id),
                    ),
                ).toBe(true),
            { timeout: 10_000 },
        );
        const initialMethod = cached!.run;
        const equal = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Equal source snapshot.",
            mode: writerMode,
        });
        await vi.waitFor(
            async () =>
                expect(
                    (await fixture.owner.getMessages(fixture.agent.id)).runs.some(
                        (run) =>
                            run.status === "failed" &&
                            run.messages.some((message) => message.id === equal.message.id),
                    ),
                ).toBe(true),
            { timeout: 10_000 },
        );
        const equalRun = (await fixture.owner.getMessages(fixture.agent.id)).runs.find((run) =>
            run.messages.some((message) => message.id === equal.message.id),
        )!;
        const cursor = fixture.journal.cursor();
        observed.length = 0;
        const second = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Later source.",
            mode: { ...writerMode, providerId: "other_account" },
        });
        await vi.waitFor(
            async () =>
                expect(
                    (await fixture.owner.getMessages(fixture.agent.id)).runs.some(
                        (run) =>
                            run.status === "failed" &&
                            run.messages.some((message) => message.id === second.message.id),
                    ),
                ).toBe(true),
            { timeout: 10_000 },
        );
        const page = await fixture.owner.getMessages(fixture.agent.id);
        const laterRun = page.runs.find((run) =>
            run.messages.some((message) => message.id === second.message.id),
        )!;
        const laterFailure = laterRun.messages
            .filter((message) => message.role === "service")
            .find(
                (message) =>
                    message.role === "service" &&
                    message.content.some(
                        (block) => block.type === "text" && block.text.includes("Later failure"),
                    ),
            );
        expect(laterFailure).toBeDefined();
        const replay = await fixture.owner.getEvents({ after: cursor });
        for (const surface of [laterRun, observed, replay]) {
            expect.soft(JSON.stringify(surface)).not.toContain(firstSelector);
            expect.soft(JSON.stringify(surface)).not.toContain(secondSelector);
        }
        expect
            .soft(
                equalRun.messages
                    .filter((message) => message.role === "service")
                    .find((message) =>
                        message.content.some(
                            (block) =>
                                block.type === "text" &&
                                block.text.includes("Equal snapshot failure"),
                        ),
                    )?.error?.credentialSource,
            )
            .toMatchObject({ kind: "configuration", location: firstSelector });
        // A shared session cannot prove which instance supplied its credential or route.
        expect(laterFailure?.error?.credentialSource ?? null).toBeNull();
        expect(laterFailure?.error?.mode?.providerId).not.toBe("private_account");
        const original = await fixture.owner.sendMessage(fixture.agent.id, {
            text: "Use the original decorator after ambiguity.",
            mode: writerMode,
        });
        await vi.waitFor(
            async () =>
                expect(
                    (await fixture.owner.getMessages(fixture.agent.id)).runs.some(
                        (run) =>
                            run.status === "failed" &&
                            run.messages.some((message) => message.id === original.message.id),
                    ),
                ).toBe(true),
            { timeout: 10_000 },
        );
        const originalRun = (await fixture.owner.getMessages(fixture.agent.id)).runs.find((run) =>
            run.messages.some((message) => message.id === original.message.id),
        )!;
        const originalFailure = originalRun.messages
            .filter((message) => message.role === "service")
            .find((message) =>
                message.content.some(
                    (block) =>
                        block.type === "text" && block.text.includes("Original decorator failure"),
                ),
            )!;
        expect(originalFailure.error?.credentialSource ?? null).toBeNull();
        expect(JSON.stringify(originalRun)).not.toContain(secondSelector);
        let thrown: unknown;
        try {
            for await (const _event of cached!.run(createRootContext(), {
                model: writerMode.modelId,
                context: { instructions: "Fixture", messages: [] },
            })) {
                /* Consume the native throw. */
            }
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const failure = thrown as Error & { diagnostics: { upstreamMessage: string } };
        for (const surface of [
            failure.message,
            failure.stack,
            String(failure.cause),
            failure.diagnostics,
        ]) {
            expect(JSON.stringify(surface)).not.toContain(firstSelector);
            expect(JSON.stringify(surface)).not.toContain(secondSelector);
        }
        expect(instances.size).toBeGreaterThanOrEqual(2);
        expect(cached!.run).toBe(initialMethod);
    } finally {
        stop();
        await fixture.close();
        vi.restoreAllMocks();
    }
}, 30_000);

it("redacts the whole diagnostic when a shared-session source union exceeds its retention bound", async () => {
    const privateMarker = "LATER_PRIVATE_SOURCE_259";
    const shared = new ScriptedSession(
        "cached",
        [
            [
                {
                    type: "done",
                    state: "error",
                    kind: "unknown",
                    message: `Failure at ${privateMarker}`,
                    providerError: {
                        type: "authentication",
                        diagnostics: { upstreamMessage: privateMarker },
                    },
                },
            ],
        ],
        { instructions: "Fixture" },
    );
    const first = new ScriptedProvider([]);
    const second = new ScriptedProvider([]);
    vi.spyOn(first, "session").mockResolvedValue(shared);
    vi.spyOn(second, "session").mockResolvedValue(shared);
    try {
        const initial = new CredentialDiagnosticSources("first", []);
        const later = new CredentialDiagnosticSources("later", []);
        for (let index = 0; index < 260; index += 1) {
            initial.add(`FIRST_PRIVATE_SOURCE_${index}`);
            later.add(`LATER_PRIVATE_SOURCE_${index}`);
        }
        await initial.snapshot().protect(first).session("cached", { instructions: "Fixture" });
        const session = await later
            .snapshot()
            .protect(second)
            .session("cached", { instructions: "Fixture" });
        const events = [];
        for await (const event of session.run(createRootContext(), {
            context: { instructions: "Fixture", messages: [] },
        }))
            events.push(event);
        expect(JSON.stringify(events)).not.toContain(privateMarker);
        expect(events).toMatchObject([
            {
                message: "[private credential diagnostic]",
                providerError: {
                    diagnostics: { upstreamMessage: "[private credential diagnostic]" },
                },
            },
        ]);
    } finally {
        vi.restoreAllMocks();
        await shared.destroy();
    }
});
