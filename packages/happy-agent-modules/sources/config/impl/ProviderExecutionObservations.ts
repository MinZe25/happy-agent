import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    credentialSourceSchema,
    errorRecoverySchema,
    messageModeSchema,
} from "@slopus/happy-agent-client";

export const MAX_EXECUTION_OBSERVATIONS = 512;
export const MAX_EXECUTION_ATTEMPTS = 64;
export const EXECUTION_OBSERVATION_TTL_MS = 15 * 60_000;
// A private cache budget, not a new wire limit. Oversized optional observations become unknown.
const MAX_EXECUTION_ATTEMPT_BYTES = 4_096;

// API.md:4298-4312,4693-4705,4720-4729 bound the public snapshot and recovery fields.
// No credential object, path, provider, session or context is retained in this store.
const attemptSchema = Type.Object(
    {
        mode: messageModeSchema,
        credentialSource: Type.Union([credentialSourceSchema, Type.Null()]),
        errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        recovery: Type.Optional(errorRecoverySchema),
    },
    { additionalProperties: false },
);
export type ProviderExecutionAttempt = Static<typeof attemptSchema>;
export type ProviderExecutionKind = "inference" | "compaction";
export type CurrentProviderExecutionAttempt = {
    readonly ordinal: number;
    readonly attempt: ProviderExecutionAttempt;
};

type Observation = {
    agentId: string;
    operationId: string;
    kind: ProviderExecutionKind;
    startedAt: number;
    handle: object;
    attempts: readonly ProviderExecutionAttempt[];
    startedAttempts: number;
    current: CurrentProviderExecutionAttempt | undefined;
};

/** Bounded, fail-closed observations, owned by one execution rather than a provider session. */
export class ProviderExecutionObservations {
    readonly #entries = new Map<object, Observation>();

    constructor(readonly now: () => number = Date.now) {}

    get size(): number {
        this.#expire();
        return this.#entries.size;
    }

    begin(agentId: string, operationId: string, kind: ProviderExecutionKind): void {
        this.#expire();
        const overlapping = [...this.#entries.values()].filter(
            (entry) => entry.agentId === agentId && entry.kind === kind,
        );
        if (overlapping.length > 0) {
            for (const entry of overlapping) this.#entries.delete(entry.handle);
            return;
        }
        while (this.#entries.size >= MAX_EXECUTION_OBSERVATIONS) {
            const oldest = this.#entries.keys().next();
            if (!oldest.done) this.#entries.delete(oldest.value);
        }
        const handle = Object.freeze({});
        this.#entries.set(handle, {
            agentId,
            operationId,
            kind,
            startedAt: this.now(),
            handle,
            attempts: Object.freeze([]),
            startedAttempts: 0,
            current: undefined,
        });
    }

    claim(agentId: string, kind: ProviderExecutionKind): object | undefined {
        this.#expire();
        return [...this.#entries.values()].find(
            (entry) => entry.agentId === agentId && entry.kind === kind,
        )?.handle;
    }

    record(handle: object, attempt: ProviderExecutionAttempt): void {
        this.#expire();
        const entry = this.#entries.get(handle);
        if (entry === undefined) return;
        // Cleaning only a fresh clone drops unknown fields without retaining their contents.
        const snapshot = Value.Clean(attemptSchema, structuredClone(attempt));
        if (
            !Value.Check(attemptSchema, snapshot) ||
            Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_EXECUTION_ATTEMPT_BYTES ||
            entry.attempts.length >= MAX_EXECUTION_ATTEMPTS
        ) {
            this.#entries.delete(handle);
            return;
        }
        entry.attempts = Object.freeze([...entry.attempts, freezeSnapshot(snapshot)]);
        entry.current = undefined;
    }

    /** Entry-time snapshot, separate from read()'s finalized attempts. */
    activate(handle: object, attempt: ProviderExecutionAttempt): void {
        this.#expire();
        const entry = this.#entries.get(handle);
        if (entry === undefined) return;
        const snapshot = Value.Clean(attemptSchema, structuredClone(attempt));
        if (
            entry.current !== undefined ||
            entry.startedAttempts >= MAX_EXECUTION_ATTEMPTS ||
            !Value.Check(attemptSchema, snapshot) ||
            Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_EXECUTION_ATTEMPT_BYTES
        ) {
            this.#entries.delete(handle);
            return;
        }
        entry.startedAttempts += 1;
        entry.current = Object.freeze({
            ordinal: entry.startedAttempts,
            attempt: freezeSnapshot(snapshot),
        });
    }

    current(agentId: string, operationId: string): CurrentProviderExecutionAttempt | undefined {
        this.#expire();
        return [...this.#entries.values()].find(
            (entry) => entry.agentId === agentId && entry.operationId === operationId,
        )?.current;
    }

    read(agentId: string, operationId: string): readonly ProviderExecutionAttempt[] | undefined {
        this.#expire();
        return [...this.#entries.values()].find(
            (entry) => entry.agentId === agentId && entry.operationId === operationId,
        )?.attempts;
    }

    end(agentId: string, operationId: string): void {
        for (const entry of this.#entries.values()) {
            if (entry.agentId === agentId && entry.operationId === operationId)
                this.#entries.delete(entry.handle);
        }
    }

    discard(handle: object): void {
        this.#entries.delete(handle);
    }

    endAgent(agentId: string): void {
        for (const entry of this.#entries.values()) {
            if (entry.agentId === agentId) this.end(agentId, entry.operationId);
        }
    }

    #expire(): void {
        const now = this.now();
        for (const entry of this.#entries.values()) {
            if (now - entry.startedAt >= EXECUTION_OBSERVATION_TTL_MS)
                this.#entries.delete(entry.handle);
        }
    }
}

function freezeSnapshot<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) freezeSnapshot(child);
        Object.freeze(value);
    }
    return value;
}
