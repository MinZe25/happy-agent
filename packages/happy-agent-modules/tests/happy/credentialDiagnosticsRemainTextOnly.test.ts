import { expect, it } from "vitest";

import { HappyMessageMapper } from "../../sources/happy/index.js";
import { diagnostic, diagnosticMessage, diagnosticText } from "../support/credentialDiagnostic.js";

it("keeps both live mobile failures and history backfill text-only", () => {
    const original = structuredClone(diagnosticMessage);
    const live = new HappyMessageMapper().map({
        id: "01900000-0000-7000-8000-000000000001",
        agentId: "agent-a",
        occurredAt: 100,
        type: "loop.settled",
        payload: {
            runId: diagnosticMessage.runId,
            stopReason: "error",
            error: diagnosticText,
            diagnostic,
        },
    });
    const backfill = new HappyMessageMapper().mapHistory([diagnosticMessage]);
    for (const projected of [live, backfill]) {
        expect(projected.length).toBeGreaterThan(0);
        const serialized = JSON.stringify(projected);
        expect(serialized).toContain("The provider could not authenticate this request.");
        expect(serialized).not.toContain("credentialSource");
        expect(serialized).not.toContain("PRIVATE_PROVIDER_TOKEN");
        expect(serialized).not.toContain("private-login-host");
        expect(serialized).not.toContain("private-login-command");
    }
    expect(diagnosticMessage).toEqual(original);
});
