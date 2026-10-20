import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AutoReviewHistoryModule } from "../../sources/auto/impl/AutoReviewHistoryModule.js";
import { HistoryModule } from "../../sources/history/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const context: Context = createRootContext().named("auto-review-history-test");

function scope(id: string): AgentModuleScope {
    return { agent: { id }, kv: undefined } as unknown as AgentModuleScope;
}

describe("AutoReviewHistoryModule", () => {
    it("offers the history reader only while a review of that reviewer runs", async () => {
        const module = new AutoReviewHistoryModule(new HistoryModule());
        const hooks = await resolveModuleHooks(context, module);

        expect(await hooks.tools?.(context, scope("reviewer"))).toEqual([]);

        module.beginReview("reviewer", context, "reviewedagent");
        const tools = await hooks.tools?.(context, scope("reviewer"));
        expect(tools?.map((tool) => tool.name)).toEqual(["read_agent_history"]);
        // The private reviewer has no tool discovery, and its reads use the main database rather
        // than a transaction of the private system.
        expect(tools?.[0]).toMatchObject({ defer: false, transactional: false });
        expect(await hooks.tools?.(context, scope("otherreviewer"))).toEqual([]);

        module.endReview("reviewer");
        expect(await hooks.tools?.(context, scope("reviewer"))).toEqual([]);
    });
});
