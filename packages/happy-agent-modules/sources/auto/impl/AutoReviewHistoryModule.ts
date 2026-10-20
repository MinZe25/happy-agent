import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { HistoryModule } from "../../history/index.js";

/**
 * The private review system's read-only view of agent history.
 *
 * A reviewer's transcript holds only the reviewed agent's own evidence, from its current evidence
 * generation. A sub-agent's request is often authorized by a person who spoke to its parent, and a
 * compaction leaves an earlier request outside the transcript. The reviewer can follow either with
 * the history module's own `read_agent_history`, which tells a person's messages from agent
 * deliveries, so the policy can trust only the former.
 *
 * History lives in the main database, which only the review's own context carries. `AutoModule`
 * records that context for exactly one review and forgets it when the review settles, so a tool
 * array asked for outside a review is empty and the reviewer never keeps a finished review's
 * context.
 */
export class AutoReviewHistoryModule implements AgentModule {
    readonly name = "autoReviewHistory";

    readonly #history: HistoryModule;
    /** The review in progress for each reviewer: its context, and the agent it reviews. */
    readonly #reviews = new Map<string, { readonly ctx: Context; readonly agentId: string }>();

    constructor(history: HistoryModule) {
        this.#history = history;
    }

    /** Let one reviewer read history as `agentId` would, through `ctx`, until `endReview`. */
    beginReview(reviewerAgentId: string, ctx: Context, agentId: string): void {
        this.#reviews.set(reviewerAgentId, { ctx, agentId });
    }

    endReview(reviewerAgentId: string): void {
        this.#reviews.delete(reviewerAgentId);
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => {
            const review = this.#reviews.get(scope.agent.id);
            return review === undefined
                ? []
                : this.#history.reviewerTools(review.ctx, review.agentId);
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}
