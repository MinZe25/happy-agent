import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { HistoryDump } from "../../sources/observation/impl/HistoryDump.js";
import { diagnosticMessage, diagnosticText } from "../support/credentialDiagnostic.js";

it("omits display-only credential diagnostics before writing a diagnostic copy", async () => {
    const folder = await mkdtemp(join(tmpdir(), "diagnostic-dump-"));
    const dump = new HistoryDump(folder);
    const original = structuredClone(diagnosticMessage);
    try {
        await dump.record("agent-a", [diagnosticMessage]);
        await dump.flush();
        const text = await readFile(join(folder, "agent-a.jsonl"), "utf8");
        const recorded = JSON.parse(text);
        expect(recorded.recordId).toBe(diagnosticMessage.recordId);
        expect(recorded.blocks).toEqual([{ type: "text", text: diagnosticText }]);
        expect(recorded).not.toHaveProperty("error");
        expect(text).not.toContain("PRIVATE_PROVIDER_TOKEN");
        expect(text).not.toContain("private-login-host");
        expect(text).not.toContain("private-login-command");
        expect(diagnosticMessage).toEqual(original);
    } finally {
        await dump.close();
        await rm(folder, { recursive: true, force: true });
    }
});
