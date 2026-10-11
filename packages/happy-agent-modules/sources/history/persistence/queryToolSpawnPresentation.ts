import { agentDatabaseRun } from "@slopus/happy-agent-base";
import {
    agentSpawnPresentationSchema,
    type AgentSpawnPresentation,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { historyMessageWithinPersistenceBounds, type HistoryMessage } from "../HistoryMessage.js";
import { queryToolCallMessage } from "./queryToolCallMessage.js";

/** Atomically add a resolved identity or successful child ID without rewriting recorded facts. */
export async function queryRecordToolSpawnPresentation(
    ctx: Context,
    agentId: string,
    callId: string,
    presentation: AgentSpawnPresentation,
): Promise<HistoryMessage | undefined> {
    if (!Value.Check(agentSpawnPresentationSchema, presentation)) {
        throw new Error("The history module received an invalid spawn presentation.");
    }
    return await ctx.inTx(async (txCtx) => {
        const message = await queryToolCallMessage(txCtx, agentId, callId);
        if (message === undefined)
            throw new Error("The spawning tool call is missing from history.");
        const call = message.blocks.find(
            (block) => block.type === "tool_call" && block.callId === callId,
        );
        if (call?.type !== "tool_call" || call.name !== "create_agent") {
            throw new Error("The spawn presentation does not belong to a creation call.");
        }
        const previous = call.spawnPresentation;
        if (
            previous?.model !== undefined &&
            presentation.model !== undefined &&
            (previous.model.modelId !== presentation.model.modelId ||
                previous.model.providerId !== presentation.model.providerId ||
                previous.model.name !== presentation.model.name)
        ) {
            throw new Error("The spawning tool call already has another resolved model.");
        }
        if (
            previous?.agentId !== undefined &&
            presentation.agentId !== undefined &&
            previous.agentId !== presentation.agentId
        ) {
            throw new Error("The spawning tool call already has another child identity.");
        }
        const model = previous?.model ?? presentation.model;
        const childId = previous?.agentId ?? presentation.agentId;
        const resolved: AgentSpawnPresentation = {
            type: "agent_spawn",
            ...(model === undefined ? {} : { model }),
            ...(childId === undefined ? {} : { agentId: childId }),
        };
        if (JSON.stringify(previous) === JSON.stringify(resolved)) return undefined;
        const updated: HistoryMessage = {
            ...message,
            blocks: message.blocks.map((block) =>
                block === call ? { ...call, spawnPresentation: resolved } : block,
            ),
        };
        if (!historyMessageWithinPersistenceBounds(updated)) {
            throw new Error("The spawn presentation exceeds its durable message bounds.");
        }
        await agentDatabaseRun(
            txCtx.db,
            sql`UPDATE happy_agent_module_history
            SET message_json = ${JSON.stringify(updated)}
            WHERE agent_id = ${agentId} AND record_id = ${message.recordId}`,
        );
        return updated;
    });
}
