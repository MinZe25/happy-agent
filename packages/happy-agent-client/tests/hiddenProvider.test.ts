import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    configResponseSchema,
    daemonConfigSchema,
    providerConfigSchema,
} from "../sources/index.js";

const provider = {
    type: "codex",
    enabled: true,
    models: [{ id: "openai/gpt-5.6-sol", enabled: true }],
};

describe("provider hidden flag", () => {
    it.each(["Current CLI", "alex@gmail.com", "Alex Acme"])(
        "accepts a friendly account name %s",
        (name) => {
            expect(Value.Check(providerConfigSchema, { ...provider, name })).toBe(true);
        },
    );

    it.each(["", "   ", "x".repeat(257)])("rejects an invalid account name %#", (name) => {
        expect(Value.Check(providerConfigSchema, { ...provider, name })).toBe(false);
    });
    it.each([true, false])("accepts an explicit hidden value %#", (hidden) => {
        expect(Value.Check(providerConfigSchema, { ...provider, hidden })).toBe(true);
    });

    it("accepts an older daemon's entry without hidden", () => {
        const config = { ...Value.Create(daemonConfigSchema), providers: { codex: provider } };
        expect(Value.Check(configResponseSchema, { config })).toBe(true);
    });

    it("rejects a non-boolean hidden value", () => {
        expect(Value.Check(providerConfigSchema, { ...provider, hidden: "yes" })).toBe(false);
    });
});
