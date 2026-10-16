import { expect, it } from "vitest";

import { ApiEventJournal } from "../../sources/api/ApiEventJournal.js";
import { diagnostic, diagnosticText } from "../support/credentialDiagnostic.js";

it("retains only its configured number of original diagnostic event objects", () => {
    const journal = new ApiEventJournal(2);
    const start = journal.cursor();
    const payload = {
        agentId: "agent-a",
        runId: "diagnostic-run",
        message: {
            id: "diagnostic-message",
            role: "service",
            content: [{ type: "text", text: diagnosticText }],
            metadata: {},
            error: diagnostic,
        },
    };
    const first = journal.append("message.created", payload);
    const second = journal.append("message.updated", payload);
    const third = journal.append("message.updated", payload);
    const retained = journal.replay(undefined, undefined, 2)!.events;
    expect(retained).toHaveLength(2);
    expect(retained[0]).toBe(second);
    expect(retained[1]).toBe(third);
    expect(first.payload).toEqual(payload);
    expect(retained.map((event) => event.payload)).toEqual([payload, payload]);
    expect(journal.hasCursor(start)).toBe(false);
});
