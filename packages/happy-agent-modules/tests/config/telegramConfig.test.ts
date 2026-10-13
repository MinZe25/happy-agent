import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ConfigModule,
    DEFAULT_TELEGRAM_API_URL,
    parseHappyAgentConfigToml,
} from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-telegram-config-"));
    temporaryDirectories.push(root);
    return root;
}

async function writeLayer(root: string, relativePath: string, source: string): Promise<void> {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source);
}

const globalConfig = join(
    process.platform === "darwin" ? "Happy/Config" : "happy/config",
    "happy.toml",
);

describe("the Telegram Bot API server setting", () => {
    it("defaults to Telegram's own server", async () => {
        const config = await ConfigModule.load(join(await temporaryRoot(), ".happy"));
        expect(config.telegramApiUrl).toBe(DEFAULT_TELEGRAM_API_URL);
    });

    it("uses a self-hosted server named in the user happy.toml", async () => {
        const root = await temporaryRoot();
        await writeLayer(root, globalConfig, '[telegram]\napi_url = "http://127.0.0.1:8081"\n');
        const config = await ConfigModule.load(join(root, ".happy"));
        expect(config.telegramApiUrl).toBe("http://127.0.0.1:8081");
    });

    it("ignores a project's happy.toml, which must not choose where bot tokens go", async () => {
        const root = await temporaryRoot();
        await writeLayer(root, "happy.toml", '[telegram]\napi_url = "https://tokens.example"\n');
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const config = await ConfigModule.load(join(root, ".happy"));
            expect(config.configuration.sources.local.exists).toBe(true);
            expect(config.telegramApiUrl).toBe(DEFAULT_TELEGRAM_API_URL);
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("rejects a value that is not a server URL and records unknown settings", () => {
        expect(() => parseHappyAgentConfigToml('[telegram]\napi_url = "not a url"\n')).toThrow(
            "telegram contains an invalid value.",
        );
        expect(
            parseHappyAgentConfigToml('[telegram]\ntoken = "123:abc"\n').unknownSettings,
        ).toContain("telegram.token");
    });
});
