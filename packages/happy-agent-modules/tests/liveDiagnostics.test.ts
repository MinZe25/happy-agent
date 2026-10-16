import { createRootContext, withLogger } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { logLiveDiagnostic, type LiveDiagnostic } from "../sources/live/impl/liveDiagnostics.js";

it("drops unrecognized diagnostic content and oversized records before writing to the local logger", () => {
    const info = vi.fn();
    const ctx = withLogger(createRootContext(), {
        info,
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
    });
    const scope = {
        sessionId: "call",
        windowId: "window",
        contextRevision: 1,
        elapsedMs: 2,
        suppressed: 0,
    };
    logLiveDiagnostic(ctx, scope, {
        event: "provider.ready",
        rawError: "Private diagnostic sentinel",
    } as unknown as LiveDiagnostic);
    logLiveDiagnostic(ctx, scope, {
        event: "controller.failed",
        detail: {
            phase: "providerDone",
            reason: "providerError",
            providerErrorKind: "Private diagnostic sentinel",
        },
    } as unknown as LiveDiagnostic);
    logLiveDiagnostic(ctx, { ...scope, contextRevision: Number.NaN }, { event: "provider.ready" });
    logLiveDiagnostic(ctx, { ...scope, windowId: "x".repeat(32_769) }, { event: "provider.ready" });
    // Escaping valid bounded strings can still push the serialized record over its byte budget.
    const largeId = "\\".repeat(512);
    logLiveDiagnostic(ctx, scope, {
        event: "delegation.started",
        inputTranscriptIds: Array.from({ length: 32 }, () => largeId),
    });
    expect(info).not.toHaveBeenCalled();
    logLiveDiagnostic(ctx, scope, {
        event: "controller.failed",
        category: "inference",
        detail: {
            phase: "providerDone",
            reason: "providerError",
            providerErrorKind: "unknown",
            round: 1,
        },
    });
    expect(info).toHaveBeenCalledOnce();
    expect(JSON.stringify(info.mock.calls)).not.toContain("Private diagnostic sentinel");
});
