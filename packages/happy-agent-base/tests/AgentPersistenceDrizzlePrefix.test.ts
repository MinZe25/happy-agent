import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { AgentStorage } from "../sources/index.js";
import { prefixSuccessor } from "../sources/AgentPersistenceDrizzle.js";
import { inMemoryStorageLock } from "./gym/fixtures.js";
import { databaseBackends } from "./gym/databaseBackends.js";

const ctx = createRootContext().named("agent-persistence-prefix-test");

vi.setConfig({ testTimeout: 30_000 });

const MAX = "\u{10FFFF}";
const KEYS = [
    "",
    "a",
    "a.b",
    "a.b.c",
    "a/",
    "ab",
    "b",
    `a${MAX}`,
    `a${MAX}x`,
    `a${MAX}${MAX}`,
    `${MAX}`,
    `${MAX}z`,
    "a😀",
    "a😀.b",
    "a\u{D7FF}",
    "a\u{D7FF}x",
    "a\u{E000}",
    "a\uFFFF",
];
const PREFIXES = ["", "a", "a.", "a.b", "a😀", `a${MAX}`, MAX, "a\u{D7FF}", "a\uFFFF", "zzz"];

describe("prefixSuccessor", () => {
    it("bounds every extension of the prefix and nothing it does not prefix", () => {
        for (const prefix of PREFIXES) {
            const upper = prefixSuccessor(prefix);
            for (const key of KEYS) {
                if (upper === undefined) continue;
                const inRange =
                    Buffer.compare(Buffer.from(key), Buffer.from(prefix)) >= 0 &&
                    Buffer.compare(Buffer.from(key), Buffer.from(upper)) < 0;
                expect(inRange, `${JSON.stringify(prefix)} ${JSON.stringify(key)}`).toBe(
                    key.startsWith(prefix),
                );
            }
        }
    });

    it("has no bound for an empty prefix or one of only maximum code points", () => {
        expect(prefixSuccessor("")).toBeUndefined();
        expect(prefixSuccessor(`${MAX}${MAX}`)).toBeUndefined();
        expect(prefixSuccessor(`a${MAX}`)).toBe("b");
        expect(prefixSuccessor("a\u{D7FF}")).toBe("a\u{E000}");
    });
});

describe.each(databaseBackends)("AgentPersistenceDrizzle prefix reads ($label)", ({ open }) => {
    it("returns exactly the keys that start with the prefix", async () => {
        const { close, database } = await open();
        try {
            const storage = new AgentStorage({ acquireLock: inMemoryStorageLock(), database });
            await storage.migrate(ctx, []);
            const persistence = storage.persistence("owner");
            for (const key of KEYS) await persistence.writeValue(ctx, key, key);
            for (const prefix of PREFIXES) {
                const read = (await persistence.readValues(ctx, prefix)).map(({ key }) => key);
                expect(read.sort(), JSON.stringify(prefix)).toEqual(
                    KEYS.filter((key) => key.startsWith(prefix)).sort(),
                );
            }
        } finally {
            await close();
        }
    });
});
