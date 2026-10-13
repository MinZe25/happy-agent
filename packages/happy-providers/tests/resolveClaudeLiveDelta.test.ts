import { describe, expect, it } from "vitest";

import type { SessionMessage } from "@/core/SessionContext.js";
import { claudeMessageIdentity } from "@/vendors/claude/impl/claudeMessageIdentity.js";
import { resolveClaudeLiveDelta } from "@/vendors/claude/impl/resolveClaudeLiveDelta.js";

const question: SessionMessage = { role: "user", content: [{ type: "text", text: "Question." }] };
const answer: SessionMessage = { role: "assistant", content: [{ type: "text", text: "Answer." }] };

function deltaAfter(next: SessionMessage) {
    const sent = [question, answer];
    const messages = [...sent, next];
    return resolveClaudeLiveDelta({
        incoming: messages.map(claudeMessageIdentity),
        messages,
        pendingToolCallIds: [],
        sent: sent.map(claudeMessageIdentity),
    });
}

describe("resolveClaudeLiveDelta", () => {
    it("hands the live query one turn that becomes a user prompt", () => {
        expect(deltaAfter({ role: "user", content: [{ type: "text", text: "More." }] })).toEqual({
            kind: "prompt",
        });
        expect(
            deltaAfter({
                role: "system",
                content: [{ type: "text", text: "Continue from where you left off." }],
            }),
        ).toEqual({ kind: "prompt" });
    });

    it("restarts rather than handing the prompt queue a turn it cannot deliver", () => {
        expect(
            deltaAfter({ role: "assistant", content: [{ type: "text", text: "Partial." }] }),
        ).toEqual({ kind: "restart" });
        expect(
            deltaAfter({ role: "compaction", content: "Summary.", encryptedContent: null }),
        ).toEqual({ kind: "restart" });
        expect(deltaAfter({ role: "tool", callId: "call", content: [] })).toEqual({
            kind: "restart",
        });
    });
});
