import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders } from "@slopus/happy-agent-base";
import {
    CodexApiKeyCredential,
    CodexProvider,
    CodexSessionCredential,
} from "@slopus/happy-providers";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceSettingsError } from "../../sources/config/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});
async function fixture(
    endpoint?: string,
    extra = "",
    credential?: CodexSessionCredential,
    smart = false,
) {
    const root = await mkdtemp(join(tmpdir(), "live-config-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const provider = new CodexProvider({
        credential: credential ?? (await CodexApiKeyCredential.tryLoad({ apiKey: "fixture-key" }))!,
        ...(endpoint === undefined ? {} : { endpoint }),
    });
    const providers = new AgentProviders();
    providers.add("voice", provider, "codex");
    const config = await testConfigRootedAt(
        root,
        `[providers.voice]\ntype="codex"\nenabled=true\n${extra}`,
        {
            inference: () => ({
                providers,
                models: [
                    {
                        id: "openai/gpt-6-astra",
                        name: "Fixture",
                        providerId: smart ? "pool" : "voice",
                        defaultEffort: "high",
                        effortLevels: ["high"],
                    },
                    {
                        id: "openai/gpt-6.1-sol",
                        name: "GPT-6.1 Sol",
                        providerId: smart ? "pool" : "voice",
                        defaultEffort: "medium",
                        effortLevels: ["low", "medium"],
                    },
                ],
            }),
        },
    );
    cleanups.push(() => config.closeProviders());
    return { config, provider, providers };
}
it("uses exactly the explicitly selected official account and configured-default controller", async () => {
    const f = await fixture();
    const session = vi.spyOn(f.provider, "session");
    expect(await f.config.liveCredential({ type: "openai_api_key", providerId: "voice" })).toEqual({
        type: "openai_api_key",
        token: "fixture-key",
    });
    expect(await f.config.liveControllerRoute()).toMatchObject({
        provider: f.provider,
        model: { providerId: "voice", id: "openai/gpt-6.1-sol", defaultEffort: "low" },
    });
    expect(session).not.toHaveBeenCalled();
});
it("freezes a smart default onto its hidden enabled account without changing the voice selection", async () => {
    const f = await fixture(
        undefined,
        'hidden=true\n[providers.pool]\ntype="smart"\nproviders=["voice"]\nenabled=true\n',
        undefined,
        true,
    );
    expect(f.config.models[0]?.providerId).toBe("pool");
    expect(await f.config.liveControllerRoute()).toMatchObject({
        provider: f.provider,
        model: { providerId: "voice", id: "openai/gpt-6.1-sol", defaultEffort: "low" },
    });
    expect(await f.config.liveCredential({ type: "openai_api_key", providerId: "voice" })).toEqual({
        type: "openai_api_key",
        token: "fixture-key",
    });
    await expect(
        f.config.liveCredential({ type: "codex_subscription", providerId: "pool" }),
    ).rejects.toThrow(
        "Select an individual OpenAI account for voice; account pools cannot supply voice credentials.",
    );
});
const controllerPool =
    'hidden=true\n[providers.controller]\ntype="codex"\nenabled=true\nhidden=true\n' +
    '[providers.pool]\ntype="smart"\nproviders=["controller","voice"]\nenabled=true\n';
it.each(["controller", "pool"])(
    "keeps a frozen controller on its account after refusal and observes later %s disablement",
    async (disabledProvider) => {
        const f = await fixture(undefined, controllerPool, undefined, true);
        const controller = new ScriptedProvider([
            [{ type: "done", state: "error", kind: "unknown", message: "Signed out." }],
            (ctx) =>
                (async function* () {
                    expect(ctx.lifetime?.aborted).toBe(true);
                    yield { type: "done", state: "cancelled" } as const;
                })(),
        ]);
        f.providers.add("controller", controller, "codex");
        vi.spyOn(Math, "random").mockReturnValue(0);
        const other = vi.spyOn(f.provider, "session");
        const route = await f.config.liveControllerRoute();
        expect(route.signal?.aborted).toBe(false);
        expect(route.provider).toBe(controller);
        expect(route.model).toMatchObject({ providerId: "controller", defaultEffort: "low" });
        const session = await route.provider.session("frozen-controller", {
            instructions: "",
            tools: [],
        });
        const request = { model: route.model.id, context: { instructions: "", messages: [] } };
        try {
            const first = [];
            for await (const event of session.run(
                withLifetime(createRootContext(), route.signal!),
                request,
            ))
                first.push(event);
            expect(first.at(-1)).toMatchObject({ state: "error", message: "Signed out." });
            f.config.setProviderEnabled(disabledProvider, false);
            expect(route.signal?.aborted).toBe(true);
            const disabled = [];
            for await (const event of session.run(
                withLifetime(createRootContext(), route.signal!),
                request,
            ))
                disabled.push(event);
            expect(disabled.at(-1)).toMatchObject({ state: "cancelled" });
            expect(f.config.isProviderEnabled("voice")).toBe(true);
            expect(other).not.toHaveBeenCalled();
        } finally {
            await session.destroy();
        }
    },
);
it("does not try another pool credential when its selected controller cannot load", async () => {
    const f = await fixture(undefined, controllerPool, undefined, true);
    f.providers.add(
        "controller",
        async () => {
            throw new Error("The selected controller is signed out.");
        },
        "codex",
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const other = vi.spyOn(f.provider, "session");
    await expect(f.config.liveControllerRoute()).rejects.toThrow(
        "selected controller is signed out",
    );
    expect(other).not.toHaveBeenCalled();
});
it("reloads the selected native credential once without refreshing or changing accounts", async () => {
    const credential = CodexSessionCredential.fromAuth(
        { accessToken: "old", accountId: "fixture" },
        { authFile: "/unused-live-fixture" },
    );
    const current = CodexSessionCredential.fromAuth(
        { accessToken: "current", accountId: "fixture" },
        { authFile: "/unused-live-fixture" },
    );
    const reload = vi.spyOn(credential, "reloadForUnauthorized").mockResolvedValue(current);
    const refresh = vi.spyOn(credential, "refreshForUnauthorized");
    const f = await fixture(undefined, "", credential);
    expect(
        await f.config.liveCredential({ type: "codex_subscription", providerId: "voice" }),
    ).toEqual({ type: "codex_subscription", token: "current", accountId: "fixture" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
});
it.each([
    "https://proxy.example/v1",
    "https://user:password@api.openai.com/v1",
    "http://api.openai.com/v1",
])("never forwards a custom-origin credential from %s to OpenAI Live", async (endpoint) => {
    const f = await fixture(endpoint);
    await expect(
        f.config.liveCredential({ type: "openai_api_key", providerId: "voice" }),
    ).rejects.toThrow("official OpenAI");
});
it("refuses credential-kind mismatches and disabled accounts without fallback", async () => {
    const f = await fixture();
    await expect(
        f.config.liveCredential({ type: "codex_subscription", providerId: "voice" }),
    ).rejects.toThrow();
    f.config.setProviderEnabled("voice", false);
    await expect(
        f.config.liveCredential({ type: "openai_api_key", providerId: "voice" }),
    ).rejects.toThrow();
    await expect(f.config.liveControllerRoute()).rejects.toThrow(
        "No account is enabled for voice. Enable an account, then choose a controller model in voice settings.",
    );
});
it("runs the controller on the configured voice model, effort and fast mode", async () => {
    const f = await fixture(
        undefined,
        '[voice]\ncontroller_model="openai/gpt-6-astra"\ncontroller_fast_mode=true\n',
    );
    expect(f.config.voiceController()).toEqual(
        expect.objectContaining({
            providerId: "voice",
            modelId: "openai/gpt-6-astra",
            effort: "high",
            serviceTier: null,
            notice: "Fast mode is not available for Fixture, so it is ignored.",
        }),
    );
    const route = await f.config.liveControllerRoute();
    expect(route).toMatchObject({
        provider: f.provider,
        model: { providerId: "voice", id: "openai/gpt-6-astra", defaultEffort: "high" },
        effort: "high",
    });
    expect(route).not.toHaveProperty("serviceTier");
});
it("stores voice settings in generated runtime configuration over the machine file", async () => {
    const f = await fixture(undefined, '[voice]\nsystem_prompt="File prompt."\n');
    expect(f.config.voiceSettings).toEqual({ system_prompt: "File prompt." });
    const runtimePath = f.config.configuration.paths.runtimeConfigPath;
    expect(
        await f.config.updateRuntimeVoiceSettings(createRootContext(), {
            controller_effort: "medium",
            system_prompt: "Runtime prompt.",
        }),
    ).toBe(true);
    expect(f.config.voiceSettings).toEqual({
        controller_effort: "medium",
        system_prompt: "Runtime prompt.",
    });
    expect(await readFile(runtimePath, "utf8")).toContain("Runtime prompt.");
    expect((await f.config.liveControllerRoute()).effort).toBe("medium");
    expect(
        await f.config.updateRuntimeVoiceSettings(createRootContext(), {
            controller_effort: "medium",
        }),
    ).toBe(false);
    await f.config.updateRuntimeVoiceSettings(createRootContext(), {
        controller_effort: null,
        system_prompt: null,
    });
    expect(f.config.voiceSettings).toEqual({ system_prompt: "File prompt." });
    expect(await readFile(runtimePath, "utf8")).not.toContain("Runtime prompt.");
});
it.each(["", 'controller_effort="medium"\n'])(
    "validates a model change and effort reset against the resulting file/default settings (%s)",
    async (fileSettings) => {
        const f = await fixture(undefined, `[voice]\n${fileSettings}`);
        await f.config.updateRuntimeVoiceSettings(createRootContext(), {
            controller_model: "openai/gpt-6-astra",
            controller_effort: "high",
        });
        await f.config.updateRuntimeVoiceSettings(createRootContext(), {
            controller_model: "openai/gpt-6.1-sol",
            controller_effort: null,
        });
        expect(f.config.voiceSettings).toEqual({
            controller_model: "openai/gpt-6.1-sol",
            ...(fileSettings ? { controller_effort: "medium" } : {}),
        });
        expect((await f.config.liveControllerRoute()).effort).toBe(fileSettings ? "medium" : "low");
    },
);
it("rejects resetting to an incompatible file effort without changing runtime settings", async () => {
    const f = await fixture(undefined, '[voice]\ncontroller_effort="high"\n');
    await f.config.updateRuntimeVoiceSettings(createRootContext(), {
        controller_effort: "medium",
    });
    const before = await readFile(f.config.configuration.paths.runtimeConfigPath, "utf8");
    await expect(
        f.config.updateRuntimeVoiceSettings(createRootContext(), { controller_effort: null }),
    ).rejects.toThrow("GPT-6.1 Sol does not accept high effort.");
    expect(f.config.voiceSettings.controller_effort).toBe("medium");
    expect(await readFile(f.config.configuration.paths.runtimeConfigPath, "utf8")).toBe(before);
});
it("removes obsolete runtime controller overrides without validating the removed model", async () => {
    const f = await fixture();
    await f.config.updateRuntimeVoiceSettings(createRootContext(), {
        controller_model: "openai/gpt-6-astra",
        controller_effort: "high",
    });
    const remaining = f.config.offeredModels.filter((model) => model.id !== "openai/gpt-6-astra");
    vi.spyOn(f.config, "offeredModels", "get").mockReturnValue(remaining);
    await f.config.updateRuntimeVoiceSettings(createRootContext(), {
        controller_model: null,
        controller_effort: null,
    });
    expect(f.config.voiceSettings).toEqual({});
    expect((await f.config.liveControllerRoute()).effort).toBe("low");
});
it.each([true, false])(
    "keeps an incompatible configured default account selected when enabled=%s",
    async (enabled) => {
        const f = await fixture(
            undefined,
            `[defaults]\nprovider="claude"\nmodel="anthropic/sonnet-5"\n[providers.claude]\ntype="claude"\nenabled=${enabled}\n`,
        );
        expect(f.config.voiceController()).toMatchObject({
            providerId: "claude",
            modelId: "openai/gpt-6.1-sol",
            model: undefined,
            notice: expect.stringContaining("voice cannot start"),
        });
        await expect(f.config.liveControllerRoute()).rejects.toThrow("voice cannot start");
        expect(f.config.isProviderEnabled("voice")).toBe(true);
    },
);
it.each([
    [{ controller_provider: "missing" }, "The selected controller account is not configured."],
    [{ controller_model: "openai/unknown" }, "No configured account offers openai/unknown."],
    [{ controller_effort: "xhigh" }, "GPT-6.1 Sol does not accept xhigh effort."],
])("refuses an unusable controller selection %j before storing it", async (update, message) => {
    const f = await fixture();
    const refused = f.config.updateRuntimeVoiceSettings(createRootContext(), update);
    await expect(refused).rejects.toBeInstanceOf(VoiceSettingsError);
    await expect(refused).rejects.toThrow(message);
    expect(f.config.voiceSettings).toEqual({});
});
