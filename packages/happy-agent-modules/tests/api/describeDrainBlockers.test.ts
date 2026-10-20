import { describe, expect, it } from "vitest";

import { describeDrainBlockers } from "../../sources/api/impl/describeDrainBlockers.js";

describe("the drain blocker summary", () => {
    it("groups blockers by tool or stage, oldest first, with the oldest age of each", () => {
        const now = 1_000_000;
        const summary = describeDrainBlockers(
            [
                { category: "inference", startedAt: now - 4_000 },
                { category: "BashOutput", startedAt: now - 312_000 },
                { category: "BashOutput", startedAt: now - 10_000 },
                { category: "settlement", startedAt: undefined },
            ],
            now,
        );

        expect(summary.text).toBe("BashOutputx2@312s,inferencex1@4s,settlementx1");
        expect(summary.key).toBe("BashOutput:2,inference:1,settlement:1");
    });

    it("changes its key when the work changes, not when time passes", () => {
        const blockers = [{ category: "Bash", startedAt: 0 }];
        expect(describeDrainBlockers(blockers, 1_000).key).toBe(
            describeDrainBlockers(blockers, 9_000).key,
        );
        expect(describeDrainBlockers([...blockers, ...blockers], 9_000).key).not.toBe(
            describeDrainBlockers(blockers, 9_000).key,
        );
    });
});
