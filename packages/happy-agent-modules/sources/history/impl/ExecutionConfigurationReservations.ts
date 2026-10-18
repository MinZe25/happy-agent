import { randomUUID } from "node:crypto";
import type { MessageMode } from "@slopus/happy-agent-client";
import type {
    CurrentProviderExecutionAttempt,
    ProviderExecutionAttempt,
} from "../../config/index.js";
import type { HistoryMessage } from "../HistoryMessage.js";
import { executionConfigurationChanged } from "./executionConfigurationChanged.js";

export const MAX_EXECUTION_CONFIGURATION_PREPARATIONS = 512;
export const EXECUTION_CONFIGURATION_PREPARATION_TTL_MS = 15 * 60_000;
export const MAX_EXECUTION_CONFIGURATION_ATTEMPTS = 64;

type Preparation = {
    readonly agentId: string;
    readonly startedAt: number;
    readonly runId: string;
    baseline: MessageMode | null;
    beforeMessageId: string | null;
    processed: number;
    invalid: boolean;
    streamed: boolean;
    readonly records: HistoryMessage[];
};

/** Only public snapshots and identities cross the synchronous streaming boundary. */
export class ExecutionConfigurationReservations {
    readonly #entries = new Map<string, Preparation>();

    constructor(readonly now: () => number = Date.now) {}

    get size(): number {
        this.#expire();
        return this.#entries.size;
    }

    prepare(
        agentId: string,
        operationId: string,
        runId: string,
        baseline: MessageMode | null,
        beforeMessageId: string | null,
    ): void {
        this.#expire();
        const key = this.#key(agentId, operationId);
        if (this.#entries.has(key)) {
            this.invalidate(agentId, operationId);
            return;
        }
        while (this.#entries.size >= MAX_EXECUTION_CONFIGURATION_PREPARATIONS) {
            const oldest = this.#entries.keys().next();
            if (!oldest.done) this.#entries.delete(oldest.value);
        }
        this.#entries.set(key, {
            agentId,
            runId,
            baseline: freezeSnapshot(structuredClone(baseline)),
            beforeMessageId,
            startedAt: this.now(),
            processed: 0,
            invalid: false,
            streamed: false,
            records: [],
        });
    }

    reserve(
        agentId: string,
        operationId: string,
        finalized: readonly ProviderExecutionAttempt[] | undefined,
        current: CurrentProviderExecutionAttempt | undefined,
    ): readonly HistoryMessage[] {
        const entry = this.#entry(agentId, operationId);
        if (entry === undefined || entry.invalid) return [];
        entry.streamed = true;
        if (current === undefined || finalized === undefined) {
            entry.invalid = true;
            return [];
        }
        if (
            current.ordinal > MAX_EXECUTION_CONFIGURATION_ATTEMPTS ||
            finalized.length > MAX_EXECUTION_CONFIGURATION_ATTEMPTS
        ) {
            this.end(agentId, operationId);
            return [];
        }
        // Allocation is atomic in memory: an exception cannot leave unannounced partial rows.
        const staged = { ...entry, records: [...entry.records] };
        const start = staged.records.length;
        // Every observed concrete attempt participates, in order and coalesced against the last
        // allocated mode. A block_start reserves earlier finalized attempts plus the current
        // snapshot. Unknown current forbids subsequent reservation and completion-time backfill.
        // With no output, terminal completion records all finalized attempts before its error.
        this.#allocateFinalized(staged, finalized);
        this.#allocate(staged, current.ordinal, current.attempt);
        if (staged.invalid) {
            this.end(agentId, operationId);
            return [];
        }
        this.#entries.set(this.#key(agentId, operationId), staged);
        return staged.records.slice(start);
    }

    complete(
        agentId: string,
        operationId: string,
        finalized: readonly ProviderExecutionAttempt[] | undefined,
    ):
        | { readonly records: readonly HistoryMessage[]; readonly baseline: MessageMode | null }
        | undefined {
        const entry = this.#entry(agentId, operationId);
        if (entry === undefined) return undefined;
        if (finalized !== undefined && finalized.length > MAX_EXECUTION_CONFIGURATION_ATTEMPTS) {
            this.end(agentId, operationId);
            return undefined;
        }
        if (!entry.invalid && !entry.streamed && finalized !== undefined)
            this.#allocateFinalized(entry, finalized);
        return { records: [...entry.records], baseline: entry.baseline };
    }

    invalidate(agentId: string, operationId: string): void {
        const entry = this.#entries.get(this.#key(agentId, operationId));
        if (entry !== undefined) entry.invalid = true;
    }

    end(agentId: string, operationId: string): void {
        this.#entries.delete(this.#key(agentId, operationId));
    }

    endAgent(agentId: string): void {
        for (const [key, entry] of this.#entries) {
            if (entry.agentId === agentId) this.#entries.delete(key);
        }
    }

    #allocateFinalized(entry: Preparation, attempts: readonly ProviderExecutionAttempt[]): void {
        for (let index = entry.processed; index < attempts.length; index += 1)
            this.#allocate(entry, index + 1, attempts[index]!);
    }

    #allocate(entry: Preparation, ordinal: number, attempt: ProviderExecutionAttempt): void {
        if (ordinal <= entry.processed || entry.invalid) return;
        if (ordinal !== entry.processed + 1) {
            entry.invalid = true;
            return;
        }
        const mode = freezeSnapshot(structuredClone(attempt.mode));
        if (entry.baseline === null || executionConfigurationChanged(entry.baseline, mode)) {
            entry.records.push(
                freezeSnapshot({
                    at: this.now(),
                    role: "service",
                    recordId: randomUUID(),
                    runId: entry.runId,
                    blocks: [
                        {
                            type: "configuration",
                            before: entry.baseline,
                            after: mode,
                            beforeMessageId: entry.beforeMessageId,
                        },
                    ],
                }),
            );
        }
        entry.baseline = mode;
        entry.beforeMessageId = null;
        entry.processed = ordinal;
    }

    #entry(agentId: string, operationId: string): Preparation | undefined {
        this.#expire();
        return this.#entries.get(this.#key(agentId, operationId));
    }

    #key(agentId: string, operationId: string): string {
        return `${agentId}\0${operationId}`;
    }

    #expire(): void {
        const now = this.now();
        for (const [key, entry] of this.#entries) {
            if (now - entry.startedAt >= EXECUTION_CONFIGURATION_PREPARATION_TTL_MS)
                this.#entries.delete(key);
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
