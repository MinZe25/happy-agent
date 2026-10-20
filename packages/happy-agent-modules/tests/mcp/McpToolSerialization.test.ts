import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    MAX_MCP_JSON_DEPTH,
    createMcpProtocolTools,
    createMcpTool,
    mcpJsonValueSchema,
    type McpModule,
} from "../../sources/mcp/index.js";

// The tools are only serialized here, never executed, so no module is ever asked for anything.
const module = {} as McpModule;

function nestedValue(depth: number): unknown {
    let value: unknown = "leaf";
    for (let level = 0; level < depth; level++) {
        value = level % 2 === 0 ? [value] : { key: value };
    }
    return value;
}

describe("MCP tool serialization", () => {
    it("serializes a tool in proportion to its definition rather than its validation depth", () => {
        // Providers key their live queries on the tools they are given. Serialized, one direct
        // tool's result schema used to be 12 million characters, so every turn spent seconds of
        // CPU per tool building the key and the live query kept the string for its lifetime.
        const tools = [
            createMcpTool(module, "agent", "server", {
                name: "lookup",
                inputSchema: { type: "object", properties: { id: { type: "string" } } },
            }),
            ...createMcpProtocolTools(module, "agent", [{ name: "server" }]),
        ];

        for (const tool of tools) {
            expect(JSON.stringify(tool).length, tool.name).toBeLessThan(50_000);
        }
    });

    it("still validates the nesting bound the serialized form leaves out", () => {
        expect(Value.Check(mcpJsonValueSchema, nestedValue(MAX_MCP_JSON_DEPTH))).toBe(true);
        expect(Value.Check(mcpJsonValueSchema, nestedValue(MAX_MCP_JSON_DEPTH + 1))).toBe(false);
    });
});
