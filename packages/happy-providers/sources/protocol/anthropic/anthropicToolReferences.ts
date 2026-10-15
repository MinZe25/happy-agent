import type {
    BetaContentBlockParam,
    BetaMessageParam,
    BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const toolReference = Type.Object({
    type: Type.Literal("tool_reference"),
    tool_name: Type.String(),
});
const toolSearchResult = Type.Object({
    type: Type.Literal("tool_search_tool_result"),
    content: Type.Object({
        type: Type.Literal("tool_search_tool_search_result"),
        tool_references: Type.Array(Type.Unknown()),
    }),
});

/** Description of a tool that history found through native search but the request no longer offers. */
export const UNAVAILABLE_ANTHROPIC_TOOL_DESCRIPTION =
    "Unavailable: an earlier search found this tool, but it is no longer offered. Calls to it fail.";

/**
 * Anthropic validates every replayed `tool_reference` against the same request's `tools`, so a
 * tool found by an earlier native search and later withdrawn — an MCP server that failed to
 * reconnect, or a model whose tool set differs — would make every later request fail.
 *
 * With native tool search, the withdrawn tool is declared as a deferred placeholder so the
 * caller's history is sent byte for byte; a call to it reaches the caller as an unknown tool.
 * Without tool search `defer_loading` is invalid, so the dangling references alone are left out
 * of this request's copy. Neither path touches caller-owned history.
 */
export function withAnthropicToolReferences(
    messages: readonly BetaMessageParam[],
    tools: readonly BetaToolUnion[],
    hasToolSearch: boolean,
): { messages: BetaMessageParam[]; tools: BetaToolUnion[] } {
    const offered = new Set(tools.flatMap((tool) => ("name" in tool ? [tool.name] : [])));
    const missing = [...new Set(messages.flatMap(referencedToolNames))].filter(
        (name) => !offered.has(name),
    );
    if (missing.length === 0) return { messages: [...messages], tools: [...tools] };
    if (hasToolSearch) {
        return {
            messages: [...messages],
            tools: [
                ...tools,
                ...missing.map((name) => ({
                    name,
                    description: UNAVAILABLE_ANTHROPIC_TOOL_DESCRIPTION,
                    input_schema: { type: "object" as const },
                    defer_loading: true,
                })),
            ],
        };
    }
    return {
        messages: messages.map((message) =>
            typeof message.content === "string"
                ? message
                : {
                      ...message,
                      content: message.content.map((block) => withoutReferences(block, offered)),
                  },
        ),
        tools: [...tools],
    };
}

function referencedToolNames(message: BetaMessageParam): string[] {
    if (typeof message.content === "string") return [];
    return message.content.flatMap((block) =>
        Value.Check(toolSearchResult, block)
            ? block.content.tool_references.flatMap((reference) =>
                  Value.Check(toolReference, reference) ? [reference.tool_name] : [],
              )
            : [],
    );
}

function withoutReferences(
    block: BetaContentBlockParam,
    offered: ReadonlySet<string>,
): BetaContentBlockParam {
    if (!Value.Check(toolSearchResult, block)) return block;
    return {
        ...block,
        content: {
            ...block.content,
            tool_references: block.content.tool_references.filter(
                (reference) =>
                    !Value.Check(toolReference, reference) || offered.has(reference.tool_name),
            ),
        },
    } as BetaContentBlockParam;
}
