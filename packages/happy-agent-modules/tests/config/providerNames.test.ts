import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeHappyProvider } from "../../sources/happy/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider account names", () => {
    it("resolves existing builtins and explicit names without changing account identities or credentials", async () => {
        const root = await mkdtemp(join(tmpdir(), "provider-names-"));
        roots.push(root);
        const config = await testConfigRootedAt(
            root,
            [
                "[providers.claude]",
                "enabled = true",
                "[providers.work]",
                'type = "claude"',
                'name = " Alex Acme "',
                'oauth_token = "fixture-token"',
                "enabled = true",
                "hidden = true",
                "[providers.personal]",
                'type = "codex"',
                'name = "alex@gmail.com"',
                "[providers.pool]",
                'type = "smart"',
                'name = "Research"',
                'providers = ["work"]',
            ].join("\n"),
        );
        for (const id of ["claude", "codex", "grok"])
            expect(describeHappyProvider(id, id, config.providerName(id))).toEqual({
                id,
                kind: id,
                name: "Current CLI",
            });
        expect(config.providerName("work")).toBe("Alex Acme");
        expect(config.providerName("personal")).toBe("alex@gmail.com");
        expect(config.providerName("pool")).toBe("Research");
        expect(config.providerName("main_kirill2003de")).toBe("Main Kirill2003de");
        expect(config.configuration.values.providers.work).toMatchObject({
            name: "Alex Acme",
            oauthToken: "fixture-token",
            type: "claude",
            enabled: true,
            hidden: true,
        });
        expect(config.configuration.values.providers.pool).toMatchObject({ providers: ["work"] });
        const renamed = await testConfigRootedAt(
            root,
            '[providers.claude]\nenabled = true\nname = "Alex Personal"',
        );
        expect(renamed.providerName("claude")).toBe("Alex Personal");
    });

    it.each(["", "   ", "x".repeat(257)])("rejects an invalid name %#", async (name) => {
        const root = await mkdtemp(join(tmpdir(), "provider-name-invalid-"));
        roots.push(root);
        await expect(
            testConfigRootedAt(root, `[providers.claude]\nname = ${JSON.stringify(name)}`),
        ).rejects.toThrow();
    });
});
