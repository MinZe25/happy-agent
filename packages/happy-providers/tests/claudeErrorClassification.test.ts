import { describe, expect, it } from "vitest";

import { classifyClaudeError } from "@/vendors/claude/errors/claudeErrors.js";

describe("Claude authentication classification", () => {
    it("uses the SDK authentication code even when the upstream message mentions usage", () => {
        expect(
            classifyClaudeError({
                assistantError: "authentication_failed",
                message: "Authentication failed while checking the usage limit.",
            }),
        ).toMatchObject({
            type: "authentication",
            diagnostics: { code: "authentication_failed" },
        });
    });

    it("does not infer an authentication rejection from text alone", () => {
        expect(
            classifyClaudeError({ message: "An example mentions 401 authentication_failed." }),
        ).toMatchObject({ type: "unclassified" });
    });
});
