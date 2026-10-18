import { expect, it } from "vitest";
import type { HistoryRecord } from "../../sources/history/HistoryStore.js";
import { createHistoryExcerpt } from "../../sources/history/impl/createHistoryExcerpt.js";
import { configuration } from "../support/credentialDiagnostic.js";

it("configuration-only entries contribute no blank separators to model-facing excerpts", () => {
    const records: HistoryRecord[] = [
        {
            position: 0,
            message: { recordId: "baseline", role: "service", blocks: [configuration] },
        },
        {
            position: 1,
            message: {
                recordId: "user",
                role: "user",
                blocks: [{ type: "text", text: "Ordinary request." }],
            },
        },
        { position: 2, message: { recordId: "change", role: "service", blocks: [configuration] } },
        {
            position: 3,
            message: {
                recordId: "assistant",
                role: "assistant",
                blocks: [{ type: "text", text: "Ordinary answer.\n\nSecond paragraph." }],
            },
        },
    ];
    const excerpt = createHistoryExcerpt(records, 1_000);
    expect(excerpt.beginning).toBe(
        "2. USER\nText: Ordinary request.\n\n4. ASSISTANT\nText: Ordinary answer.\n\nSecond paragraph.",
    );
    expect(excerpt.recent).toBe("");
});

it("an all-configuration excerpt is empty rather than whitespace-only", () => {
    const records: HistoryRecord[] = Array.from({ length: 5 }, (_, position) => ({
        position,
        message: {
            recordId: `configuration-${position}`,
            role: "service",
            blocks: [configuration],
        },
    }));
    const excerpt = createHistoryExcerpt(records, 1_000);
    expect(excerpt.beginning).toBe("");
    expect(excerpt.recent).toBe("");
});
