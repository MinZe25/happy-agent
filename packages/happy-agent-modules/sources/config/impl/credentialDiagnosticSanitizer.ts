import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";
import type { CredentialSource, ErrorRecovery } from "@slopus/happy-agent-client";
import {
    type BaseSession,
    sessionProviderErrorDiagnosticsSchema,
    type BaseProvider,
    type SessionEvent,
    type SessionProviderErrorDiagnostics,
} from "@slopus/happy-providers";

const protectedSessions = new WeakMap<BaseSession, CredentialDiagnosticSanitizer>();
// sharedNativeSessionDoesNotReuseCredentialSource.test.ts checks 260 + 260 overflow this cap.
const MAX_DIAGNOSTIC_SOURCE_VALUES = 512;
const MAX_DIAGNOSTIC_SOURCE_CHARACTERS = 65_536;

/** Selection-time inputs only. Never reads credentials, configuration or environment after failure. */
export class CredentialDiagnosticSources {
    readonly #values = new Set<string>();
    #credentialSource: CredentialSource | null = null;
    #recovery: ErrorRecovery | undefined;

    constructor(
        readonly providerId: string,
        readonly hosts: readonly string[],
    ) {
        for (const host of hosts) this.add(host);
    }

    add(value: string | undefined): void {
        if (value !== undefined && value.trim().length > 0) this.#values.add(value);
    }

    configured(key: string, value: string | undefined): void {
        if (value !== undefined) {
            this.add(`providers.${this.providerId}.${key}`);
            this.add(value);
        }
    }

    path(value: string | undefined): void {
        if (value === undefined || value.trim().length === 0) return;
        this.add(value);
        this.add(resolve(value));
    }

    environment(name: string, value: string | undefined): void {
        if (value !== undefined && value.trim().length > 0) {
            this.add(name);
            this.add(value);
        }
    }

    snapshot(): CredentialDiagnosticSanitizer {
        return new CredentialDiagnosticSanitizer([...this.#values]);
    }

    get credentialSource(): CredentialSource | null {
        return this.#credentialSource;
    }

    get recovery(): ErrorRecovery | undefined {
        return this.#recovery;
    }

    /** Called only after the concrete credential loader has selected this source. */
    selected(kind: CredentialSource["kind"], location: string, defaultClaude = false): void {
        const host = this.hosts.at(-1);
        this.#credentialSource = {
            kind,
            location,
            host: host !== undefined && host.length > 0 && host.length <= 256 ? host : null,
        };
        const instruction =
            kind === "configuration"
                ? `If retry still fails, check ${location} in this installation's configuration, replace it if needed, reload the configuration, and retry. Signing into the native assistant alone does not replace this override.`
                : kind === "environment"
                  ? `If retry still fails, check ${location} in the daemon's environment, replace it if needed, reload that environment, and retry. Signing into the native assistant alone does not replace this override.`
                  : defaultClaude
                    ? "If retry still fails, run claude auth login on the machine hosting the agent as the same operating-system user that runs the daemon, complete the browser sign-in, then retry this conversation."
                    : "If retry still fails, check the selected native assistant sign-in using its selected configuration on the machine hosting the agent, as the same operating-system user that runs the daemon. Then retry this conversation.";
        this.#recovery = {
            steps: ["Retry this conversation first.", instruction],
            actions: ["ask_chief"],
            ...(defaultClaude
                ? { commands: [{ label: "Sign in to Claude Code", command: "claude auth login" }] }
                : {}),
        };
    }
}

/** Exact matches with identifier boundaries; ordinary model output never enters this sanitizer. */
export class CredentialDiagnosticSanitizer {
    #pattern: RegExp | undefined;
    readonly #values = new Set<string>();
    readonly #initialValues: ReadonlySet<string>;
    #redactAll = false;

    constructor(values: readonly string[]) {
        this.#include(values);
        this.#initialValues = new Set(this.#values);
    }

    /** Value equality of the original snapshot, unaffected by later shared-session unions. */
    equivalent(other: CredentialDiagnosticSanitizer): boolean {
        return (
            !this.#redactAll &&
            !other.#redactAll &&
            this.#initialValues.size === other.#initialValues.size &&
            [...this.#initialValues].every((value) => other.#initialValues.has(value))
        );
    }

    merge(other: CredentialDiagnosticSanitizer): void {
        this.#include([...other.#values], other.#redactAll);
    }

    #include(values: readonly string[], redactAll = false): void {
        if (this.#redactAll) return;
        let characters = [...this.#values].reduce((total, value) => total + value.length, 0);
        for (const value of values) {
            if (this.#values.has(value)) continue;
            characters += value.length;
            if (
                this.#values.size >= MAX_DIAGNOSTIC_SOURCE_VALUES ||
                characters > MAX_DIAGNOSTIC_SOURCE_CHARACTERS
            ) {
                redactAll = true;
                break;
            }
            this.#values.add(value);
        }
        if (redactAll) {
            this.#redactAll = true;
            this.#values.clear();
            this.#pattern = undefined;
            return;
        }
        const alternatives = [...this.#values]
            .filter((value) => value.trim().length > 0)
            .sort((left, right) => right.length - left.length)
            .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        this.#pattern =
            alternatives.length === 0
                ? undefined
                : new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives.join("|")})(?![A-Za-z0-9_])`, "g");
    }

    text(value: string): string {
        if (this.#redactAll) return "[private credential diagnostic]";
        return this.#pattern === undefined
            ? value
            : value.replace(this.#pattern, "[private credential source]");
    }

    diagnostics(value: SessionProviderErrorDiagnostics): SessionProviderErrorDiagnostics {
        // Machine classification and retry fields are not prose and must remain byte-identical.
        let result = value;
        for (const key of ["upstreamMessage", "requestId", "responseId"] as const) {
            const original = value[key];
            if (original === undefined) continue;
            const projected = this.text(original);
            if (projected !== original) result = { ...result, [key]: projected };
        }
        return result;
    }

    event(event: SessionEvent): SessionEvent {
        if (event.type === "retrying") return { ...event, reason: this.text(event.reason) };
        if (event.type !== "done" || event.state !== "error") return event;
        const diagnostics = event.providerError?.diagnostics;
        return {
            ...event,
            message: this.text(event.message),
            ...(diagnostics === undefined
                ? {}
                : {
                      providerError: {
                          ...event.providerError!,
                          diagnostics: this.diagnostics(diagnostics),
                      },
                  }),
        };
    }

    error(value: unknown, depth = 0): unknown {
        if (typeof value === "string") return this.text(value);
        if (!(value instanceof Error) || depth >= 8) return value;
        const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value);
        let changed = false;
        // V8 exposes stack through a lazy accessor backed by the original Error's native slots.
        // Materialize it for a changed clone rather than transplanting that accessor.
        const stack = value.stack;
        if (typeof stack === "string") {
            const projected = this.text(stack);
            descriptors.stack = {
                configurable: true,
                enumerable: false,
                writable: true,
                value: projected,
            };
            changed ||= projected !== stack;
        }
        for (const key of Object.keys(descriptors)) {
            if (["name", "code", "type", "errorType", "stack"].includes(key)) continue;
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor)) continue;
            const original: unknown = descriptor.value;
            const projected =
                key === "cause"
                    ? this.error(original, depth + 1)
                    : key === "diagnostics" &&
                        Value.Check(sessionProviderErrorDiagnosticsSchema, original)
                      ? this.diagnostics(original)
                      : typeof original === "string"
                        ? this.text(original)
                        : original;
            if (projected === original) continue;
            changed = true;
            descriptors[key] = { ...descriptor, value: projected };
        }
        // Preserve abort/unrelated failures by identity, and changed errors by prototype and own
        // descriptors (including classification/status). Never mutate the provider's exception.
        if (!changed) return value;
        const clone = Object.setPrototypeOf(new Error(), Object.getPrototypeOf(value));
        return Object.defineProperties(clone, descriptors);
    }

    protect(provider: BaseProvider): BaseProvider {
        const session = provider.session.bind(provider);
        // Keep the concrete provider's identity: quota, live and tier probes use instanceof.
        provider.session = async (...args) => {
            try {
                return this.protectSession(await session(...args));
            } catch (error) {
                throw this.error(error);
            }
        };
        return provider;
    }

    private protectSession(session: BaseSession): BaseSession {
        const existing = protectedSessions.get(session);
        if (existing !== undefined) {
            // Native providers currently return fresh sessions, but adapters may cache one.
            // Retain one call-through while sanitizing the union, never only the first source.
            existing.merge(this);
            return session;
        }
        const run = session.run.bind(session);
        const compact = session.compact.bind(session);
        // Retain native session properties and identity, not only BaseSession's narrow interface.
        session.run = (...args) => {
            let stream: ReturnType<BaseSession["run"]>;
            try {
                stream = run(...args);
            } catch (error) {
                throw this.error(error);
            }
            return {
                [Symbol.asyncIterator]: () => {
                    const iterator = stream[Symbol.asyncIterator]();
                    const project = async (
                        operation: () => Promise<IteratorResult<SessionEvent>>,
                    ) => {
                        try {
                            const result = await operation();
                            return result.done
                                ? result
                                : { ...result, value: this.event(result.value) };
                        } catch (error) {
                            throw this.error(error);
                        }
                    };
                    return {
                        next: (...input) => project(() => iterator.next(...input)),
                        ...(iterator.return === undefined
                            ? {}
                            : {
                                  return: (value: unknown) =>
                                      project(() => iterator.return!(value)),
                              }),
                        ...(iterator.throw === undefined
                            ? {}
                            : {
                                  throw: (error: unknown) => project(() => iterator.throw!(error)),
                              }),
                    };
                },
            };
        };
        session.compact = async (...args) => {
            try {
                const result = await compact(...args);
                return result.status === "failed"
                    ? { ...result, message: this.text(result.message) }
                    : result;
            } catch (error) {
                throw this.error(error);
            }
        };
        protectedSessions.set(session, this);
        return session;
    }
}
