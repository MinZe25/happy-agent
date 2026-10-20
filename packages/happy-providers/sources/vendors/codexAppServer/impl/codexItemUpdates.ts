import type * as acp from "@agentclientprotocol/sdk";

type Item = { readonly type: string; readonly id: string } & Record<string, unknown>;

/**
 * Translate `codex app-server` notifications for one thread into ACP session updates: streamed
 * message and reasoning text, and each command, file change, MCP call and web search as a tool
 * call that settles when Codex completes the item.
 */
export function codexItemUpdates(): {
    translate(method: string, params: Record<string, unknown>): acp.SessionUpdate[];
} {
    return {
        translate(method, params) {
            if (method === "item/agentMessage/delta") {
                return [chunk("agent_message_chunk", params["delta"])];
            }
            if (
                method === "item/reasoning/summaryTextDelta" ||
                method === "item/reasoning/textDelta"
            ) {
                return [chunk("agent_thought_chunk", params["delta"])];
            }
            if (method === "item/started") return started(params["item"] as Item);
            if (method === "item/completed") return completed(params["item"] as Item);
            return [];
        },
    };
}

function chunk(
    sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
    delta: unknown,
): acp.SessionUpdate {
    return {
        sessionUpdate,
        content: { type: "text", text: typeof delta === "string" ? delta : "" },
    };
}

function started(item: Item): acp.SessionUpdate[] {
    const call = toolCall(item);
    return call === undefined
        ? []
        : [{ sessionUpdate: "tool_call", status: "in_progress", ...call }];
}

function completed(item: Item): acp.SessionUpdate[] {
    const call = toolCall(item);
    if (call === undefined) return [];
    const status = String(item["status"] ?? "completed");
    const failed = status === "failed" || status === "declined" || item["error"] != null;
    return [
        {
            sessionUpdate: "tool_call_update",
            ...call,
            status: failed ? "failed" : "completed",
            content: [{ type: "content", content: { type: "text", text: resultText(item) } }],
        },
    ];
}

function toolCall(item: Item): Omit<acp.ToolCall, "status"> | undefined {
    switch (item.type) {
        case "commandExecution":
            return {
                toolCallId: item.id,
                title: String(item["command"] ?? "command"),
                kind: "execute",
                rawInput: { command: item["command"], cwd: item["cwd"] },
            };
        case "fileChange": {
            const changes = (item["changes"] ?? []) as { path: string }[];
            return {
                toolCallId: item.id,
                title: `Edit ${changes.map((change) => change.path).join(", ")}`,
                kind: "edit",
                rawInput: { changes },
                locations: changes.map((change) => ({ path: change.path })),
            };
        }
        case "mcpToolCall":
            // `mcp__<server>__<tool>` marks Happy's own bridged tools so they are not recorded twice.
            return {
                toolCallId: item.id,
                title: `mcp__${String(item["server"])}__${String(item["tool"])}`,
                kind: "other",
                rawInput: {
                    server: item["server"],
                    tool: item["tool"],
                    arguments: item["arguments"],
                },
            };
        case "webSearch":
            return {
                toolCallId: item.id,
                title: `Search ${String(item["query"] ?? "the web")}`,
                kind: "fetch",
                rawInput: { query: item["query"] },
            };
        case "dynamicToolCall":
        case "collabAgentToolCall":
            return {
                toolCallId: item.id,
                title: String(item["tool"] ?? item.type),
                kind: "think",
                rawInput: { arguments: item["arguments"] ?? item["prompt"] },
            };
        default:
            return undefined;
    }
}

function resultText(item: Item): string {
    if (typeof item["aggregatedOutput"] === "string") return item["aggregatedOutput"];
    const result = item["result"] as { content?: { type: string; text?: string }[] } | null;
    if (result?.content !== undefined) {
        return result.content
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("");
    }
    const error = item["error"] as { message?: string } | null;
    return error?.message ?? "";
}
