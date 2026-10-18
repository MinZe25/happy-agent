import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule, loadHappyAgentConfiguration } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];
const configDirectory = process.platform === "darwin" ? "Happy/Config" : "happy/config";

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("mobile connector configuration", () => {
    it("is enabled on the fixed port 24781 by default", async () => {
        const root = await temporaryRoot();
        const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));

        expect(configuration.values.feature.mobileConnector).toEqual({
            enabled: true,
            port: 24_781,
        });
        expect(configuration.values.feature.tailcat).toEqual({ enabled: false, port: 24_779 });
    });

    it("loads from machine configuration and reports unknown keys", async () => {
        const root = await temporaryRoot();
        await writeGlobal(
            root,
            ["[feature.mobile_connector]", "enabled = false", "port = 24800", "extra = 1"].join(
                "\n",
            ),
        );

        const config = await ConfigModule.load(join(root, ".happy"));

        expect(config.mobileConnectorEnabled).toBe(false);
        expect(config.mobileConnectorPort).toBe(24_800);
        expect(config.configuration.provenance["feature.mobileConnector.enabled"]).toBe("global");
        expect(config.configuration.provenance["feature.mobileConnector.port"]).toBe("global");
        expect(config.configuration.sources.global.unknownSettings).toEqual([
            "feature.mobile_connector.extra",
        ]);
    });

    it("rejects zero and out-of-range ports", async () => {
        const root = await temporaryRoot();
        for (const port of [0, 65_536]) {
            await writeGlobal(root, `[feature.mobile_connector]\nport = ${String(port)}\n`);
            await expect(loadHappyAgentConfiguration(join(root, ".happy"))).rejects.toThrow(
                "feature contains an invalid value",
            );
        }
    });

    it("cannot be changed by a project configuration", async () => {
        const root = await temporaryRoot();
        const previous = process.cwd();
        await writeFile(
            join(root, "happy.toml"),
            "[feature.mobile_connector]\nenabled = false\nport = 24800\n",
        );
        process.chdir(root);
        try {
            const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));
            expect(configuration.values.feature.mobileConnector).toEqual({
                enabled: true,
                port: 24_781,
            });
            expect(configuration.provenance["feature.mobileConnector.enabled"]).toBeUndefined();
        } finally {
            process.chdir(previous);
        }
    });

    it("resolves a named Tailcat identity beside the default one", async () => {
        const root = await temporaryRoot();
        const config = await ConfigModule.load(join(root, ".happy"));
        const home = join(root, ".happy", "agent", "tailcat");

        expect(config.tailcatExposurePaths("mobile")).toEqual({
            addressPath: join(home, "mobile.address"),
            home,
            keyPath: join(home, "mobile.private.json"),
            portPath: join(home, "mobile.port"),
        });
        expect(config.configuration.paths.tailcatKeyPath).toBe(join(home, "default.private.json"));
        for (const name of ["default", "", "Mobile", "../x", "a".repeat(33)]) {
            expect(() => config.tailcatExposurePaths(name)).toThrow(
                "The Tailcat exposure name is invalid.",
            );
        }
    });
});

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-config-mobile-"));
    temporaryDirectories.push(root);
    return root;
}

async function writeGlobal(root: string, source: string): Promise<void> {
    await mkdir(join(root, configDirectory), { recursive: true });
    await writeFile(join(root, configDirectory, "happy.toml"), source);
}
