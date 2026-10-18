import type { CredentialSource, MessageMode } from "@slopus/happy-agent-client";
import { expect, it } from "vitest";

type Kind = "inference" | "compaction";
type Attempt = { mode: MessageMode; credentialSource: CredentialSource | null; errorCode?: string };
type Store = {
    readonly size: number;
    begin(agentId: string, operationId: string, kind: Kind): void;
    claim(agentId: string, kind: Kind): object | undefined;
    record(handle: object, attempt: Attempt): void;
    read(agentId: string, operationId: string): readonly Attempt[] | undefined;
    end(agentId: string, operationId: string): void;
};

async function store(clock: () => number) {
    // This genuinely new internal operation is absent on the RED base. Catch only its
    // missing import, then fail one explicit assertion; never add a production stub.
    const specifier = "../../sources/config/impl/ProviderExecutionObservations.js";
    const loaded = await import(specifier).catch(() => undefined);
    expect(loaded?.ProviderExecutionObservations).toBeDefined();
    const module = loaded as {
        ProviderExecutionObservations: new (now: () => number) => Store;
        MAX_EXECUTION_OBSERVATIONS: number;
        MAX_EXECUTION_ATTEMPTS: number;
        EXECUTION_OBSERVATION_TTL_MS: number;
    };
    return { value: new module.ProviderExecutionObservations(clock), limits: module };
}

function attempt(providerId = "first"): Attempt {
    return {
        mode: {
            providerId,
            providerType: "codex",
            modelId: "openai/gpt-5.6-sol",
            account: null,
            effort: "medium",
            serviceTier: null,
            permissionMode: "auto",
        },
        credentialSource: {
            kind: "configuration",
            location: `providers.${providerId}.api_key`,
            host: "Fixture host",
        },
        errorCode: "authentication_failed",
    };
}

it("expires from begin at the TTL boundary and drops old late records after a new observation begins", async () => {
    let now = 1_000;
    const { value, limits } = await store(() => now);
    value.begin("agent", "a", "inference");
    const old = value.claim("agent", "inference")!;
    value.record(old, attempt("old"));
    now += limits.EXECUTION_OBSERVATION_TTL_MS - 1;
    expect(value.read("agent", "a")).toHaveLength(1);
    now += 1;
    expect(value.read("agent", "a")).toBeUndefined();
    expect(value.claim("agent", "inference")).toBeUndefined();
    value.begin("agent", "b", "inference");
    value.record(old, attempt("late"));
    expect(value.read("agent", "b")).toEqual([]);
    value.record(value.claim("agent", "inference")!, attempt("new"));
    expect(value.read("agent", "b")).toEqual([attempt("new")]);
});

it("evicts the oldest global observation and never reports its previously captured source", async () => {
    let now = 0;
    const { value, limits } = await store(() => now);
    value.begin("first-agent", "operation", "inference");
    const old = value.claim("first-agent", "inference")!;
    value.record(old, attempt("old"));
    for (let index = 0; index < limits.MAX_EXECUTION_OBSERVATIONS; index += 1) {
        now += 1;
        value.begin(`agent-${index}`, "operation", "inference");
    }
    expect(value.size).toBe(limits.MAX_EXECUTION_OBSERVATIONS);
    expect(value.read("first-agent", "operation")).toBeUndefined();
    expect(value.claim("first-agent", "inference")).toBeUndefined();
    value.record(old, attempt("late"));
    expect(value.read("first-agent", "operation")).toBeUndefined();
});

it("invalidates the entire observation past the attempt cap instead of keeping an earlier source", async () => {
    const { value, limits } = await store(() => 0);
    value.begin("agent", "operation", "inference");
    const handle = value.claim("agent", "inference")!;
    for (let index = 0; index < limits.MAX_EXECUTION_ATTEMPTS; index += 1)
        value.record(handle, attempt(`attempt-${index}`));
    expect(value.read("agent", "operation")).toHaveLength(limits.MAX_EXECUTION_ATTEMPTS);
    value.record(handle, attempt("terminal-overflow"));
    expect(value.read("agent", "operation")).toBeUndefined();
    expect(value.claim("agent", "inference")).toBeUndefined();
    expect(value.size).toBe(0);
});

it("invalidates overlapping observations of one kind but permits a separate compaction kind", async () => {
    const { value } = await store(() => 0);
    value.begin("agent", "a", "inference");
    const a = value.claim("agent", "inference")!;
    value.record(a, attempt("a"));
    value.begin("agent", "compact", "compaction");
    value.record(value.claim("agent", "compaction")!, attempt("compact"));
    value.begin("agent", "b", "inference");
    expect(value.claim("agent", "inference")).toBeUndefined();
    expect(value.read("agent", "a")).toBeUndefined();
    expect(value.read("agent", "b")).toBeUndefined();
    value.record(a, attempt("late-a"));
    expect(value.read("agent", "b")).toBeUndefined();
    expect(value.read("agent", "compact")).toEqual([attempt("compact")]);
});

it("reusing an invalidated operation id starts empty and cannot inherit an old handle", async () => {
    const { value } = await store(() => 0);
    value.begin("agent", "same", "inference");
    const old = value.claim("agent", "inference")!;
    value.record(old, attempt("old"));
    value.begin("agent", "collision", "inference");
    expect(value.read("agent", "same")).toBeUndefined();
    value.begin("agent", "same", "inference");
    expect(value.read("agent", "same")).toEqual([]);
    value.record(old, attempt("late"));
    expect(value.read("agent", "same")).toEqual([]);
});

it("sequential claims append actual attempts and retain the terminal attempt, not the first", async () => {
    const { value } = await store(() => 0);
    value.begin("agent", "operation", "inference");
    value.record(value.claim("agent", "inference")!, attempt("first"));
    value.record(value.claim("agent", "inference")!, attempt("terminal"));
    expect(value.read("agent", "operation")).toEqual([attempt("first"), attempt("terminal")]);
});

it("end releases payloads and invalidates a captured handle before the next observation", async () => {
    const { value } = await store(() => 0);
    value.begin("agent", "a", "inference");
    const a = value.claim("agent", "inference")!;
    value.record(a, attempt("a"));
    expect(value.read("agent", "a")).toEqual([attempt("a")]);
    value.end("agent", "a");
    expect(value.size).toBe(0);
    expect(value.read("agent", "a")).toBeUndefined();
    expect(value.claim("agent", "inference")).toBeUndefined();
    value.begin("agent", "b", "inference");
    value.record(a, attempt("late-a"));
    expect(value.read("agent", "b")).toEqual([]);
});

it("captures bounded immutable snapshots and excludes unrecognized credential fields", async () => {
    const { value } = await store(() => 0);
    value.begin("agent", "operation", "inference");
    const input = attempt();
    const original = structuredClone(input);
    value.record(value.claim("agent", "inference")!, input);
    input.mode.providerId = "changed-after-record";
    input.credentialSource!.location = "changed-after-record";
    const read = value.read("agent", "operation")!;
    expect(read).toEqual([original]);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read[0]?.mode)).toBe(true);
    expect(Object.isFrozen(read[0]?.credentialSource)).toBe(true);
    // API.md:4692-4700: location/host at most256, kind at most64; unknown fields are not retained.
    value.record(value.claim("agent", "inference")!, {
        ...attempt(),
        credentialSource: { ...attempt().credentialSource!, location: "x".repeat(257) },
    });
    expect(value.read("agent", "operation")).toBeUndefined();
    value.begin("agent", "fresh", "inference");
    value.record(value.claim("agent", "inference")!, {
        ...attempt(),
        credentialSource: {
            ...attempt().credentialSource!,
            rawToken: "UNRECOGNIZED_PRIVATE_TOKEN",
        },
    } as Attempt);
    expect(JSON.stringify(value.read("agent", "fresh")) ?? "").not.toContain(
        "UNRECOGNIZED_PRIVATE_TOKEN",
    );
});
