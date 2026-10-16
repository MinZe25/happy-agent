import type { MessageMode } from "@slopus/happy-agent-client";
import { expect, it } from "vitest";

const specifier = "../../sources/history/impl/ExecutionConfigurationReservations.js";
const implementation = await import(specifier).catch(() => undefined);
const mode: MessageMode = {
    providerId: "gym",
    modelId: "model",
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
};
const attempt = (providerId = "gym") => ({ mode: { ...mode, providerId }, credentialSource: null });

function operation(now: () => number = Date.now) {
    expect(
        implementation?.ExecutionConfigurationReservations,
        "the bounded reservation operation exists",
    ).toBeTypeOf("function");
    return new implementation.ExecutionConfigurationReservations(now);
}

it("owns immutable configuration snapshots without freezing or retaining the caller's values", () => {
    const store = operation(() => 100);
    const baseline = { ...mode, providerId: "earlier" };
    store.prepare("agent", "inference", "run", baseline, "user");
    baseline.providerId = "changed after preparation";
    const current = attempt("next");
    const rows = store.reserve("agent", "inference", [], { ordinal: 1, attempt: current });
    current.mode.providerId = "changed after reservation";
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
        at: 100,
        role: "service",
        runId: "run",
        blocks: [
            {
                type: "configuration",
                before: { ...mode, providerId: "earlier" },
                after: { ...mode, providerId: "next" },
                beforeMessageId: "user",
            },
        ],
    });
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(rows[0].blocks)).toBe(true);
    expect(Object.isFrozen(rows[0].blocks[0].after)).toBe(true);
    expect(() => {
        rows[0].blocks[0].after.providerId = "tampered";
    }).toThrow();
    rows.splice(0);
    expect(store.complete("agent", "inference", [attempt("next")]).records).toHaveLength(1);
});

it("coalesces finalized and current attempts against the last allocated mode without replaying earlier attempts", () => {
    const store = operation();
    store.prepare("agent", "inference", "run", null, "user");
    const a = attempt("a");
    const b = attempt("b");
    const rows = store.reserve("agent", "inference", [a], { ordinal: 2, attempt: b });
    expect(
        rows.map(
            (row: { blocks: Array<{ after: MessageMode }> }) => row.blocks[0]!.after.providerId,
        ),
    ).toEqual(["a", "b"]);
    expect(store.reserve("agent", "inference", [a], { ordinal: 2, attempt: b })).toEqual([]);
    expect(store.complete("agent", "inference", [a, b]).records).toEqual(rows);
});

it("invalidates all reservations rather than truncating an operation over the named attempt limit", () => {
    const store = operation();
    store.prepare("agent", "inference", "run", null, "user");
    const attempts = Array.from(
        { length: implementation.MAX_EXECUTION_CONFIGURATION_ATTEMPTS },
        (_, index) => attempt(`route-${String(index)}`),
    );
    expect(
        store.reserve("agent", "inference", attempts.slice(0, -1), {
            ordinal: attempts.length,
            attempt: attempts.at(-1),
        }),
    ).toHaveLength(implementation.MAX_EXECUTION_CONFIGURATION_ATTEMPTS);
    expect(
        store.reserve("agent", "inference", attempts, {
            ordinal: attempts.length + 1,
            attempt: attempt("overflow"),
        }),
    ).toEqual([]);
    expect(
        store.complete("agent", "inference", [...attempts, attempt("overflow")]),
    ).toBeUndefined();
    expect(store.size).toBe(0);
});

it("evicts the oldest preparation over the named global operation limit and never returns its reservations", () => {
    const store = operation();
    store.prepare("old", "inference", "run", null, "user");
    expect(store.reserve("old", "inference", [], { ordinal: 1, attempt: attempt() })).toHaveLength(
        1,
    );
    for (let index = 0; index < implementation.MAX_EXECUTION_CONFIGURATION_PREPARATIONS; index += 1)
        store.prepare(`agent-${String(index)}`, "inference", "run", null, "user");
    expect(store.size).toBe(implementation.MAX_EXECUTION_CONFIGURATION_PREPARATIONS);
    expect(store.complete("old", "inference", [attempt()])).toBeUndefined();
    expect(store.reserve("old", "inference", [], { ordinal: 1, attempt: attempt() })).toEqual([]);
});

it("expires reservations at the named TTL measured from preparation begin, not the latest reservation", () => {
    let now = 0;
    const store = operation(() => now);
    store.prepare("agent", "inference", "run", null, "user");
    now = implementation.EXECUTION_CONFIGURATION_PREPARATION_TTL_MS - 1;
    expect(
        store.reserve("agent", "inference", [], { ordinal: 1, attempt: attempt() }),
    ).toHaveLength(1);
    now = implementation.EXECUTION_CONFIGURATION_PREPARATION_TTL_MS;
    expect(store.complete("agent", "inference", [attempt()])).toBeUndefined();
    expect(store.reserve("agent", "inference", [], { ordinal: 1, attempt: attempt() })).toEqual([]);
    expect(store.size).toBe(0);
});

it("releases an operation explicitly and releases only the requested agent at settlement or abort", () => {
    const store = operation();
    store.prepare("first", "one", "run", null, "user");
    store.prepare("first", "two", "run", null, "user");
    store.prepare("other", "one", "run", null, "user");
    expect(store.size).toBe(3);
    store.end("first", "one");
    expect(store.complete("first", "one", [attempt()])).toBeUndefined();
    expect(store.size).toBe(2);
    store.endAgent("first");
    expect(store.complete("first", "two", [attempt()])).toBeUndefined();
    expect(store.size).toBe(1);
    expect(store.complete("other", "one", [attempt()]).records).toHaveLength(1);
    store.endAgent("other");
    expect(store.size).toBe(0);
});
