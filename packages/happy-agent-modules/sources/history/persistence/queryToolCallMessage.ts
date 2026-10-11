import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import {
    historyAgentIdSchema,
    historyMessageSchema,
    historyRecordIdSchema,
    type HistoryMessage,
} from "../HistoryMessage.js";

/** Read the original call through its durable index, never through the current model catalog. */
export async function queryToolCallMessage(
    ctx: Context,
    agentId: string,
    callId: string,
): Promise<HistoryMessage | undefined> {
    if (
        !Value.Check(historyAgentIdSchema, agentId) ||
        !Value.Check(historyRecordIdSchema, callId)
    ) {
        throw new Error("The history module received an invalid tool-call lookup.");
    }
    const rows = await agentDatabaseRows<{ message_json: string }>(
        ctx.db,
        sql`SELECT message_json FROM happy_agent_module_history
            WHERE agent_id = ${agentId} AND record_id = (
                SELECT record_id FROM happy_agent_module_history_tool_calls
                WHERE agent_id = ${agentId} AND call_id = ${callId} LIMIT 1
            ) LIMIT 1`,
    );
    if (rows[0] === undefined) return undefined;
    const message: unknown = JSON.parse(rows[0].message_json);
    if (!Value.Check(historyMessageSchema, message)) {
        throw new Error("The stored spawn message is invalid.");
    }
    return message;
}
