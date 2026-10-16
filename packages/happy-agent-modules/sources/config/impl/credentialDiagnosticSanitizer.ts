import { resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";
import {
    type BaseSession,
    sessionProviderErrorDiagnosticsSchema,
    type BaseProvider,
    type SessionEvent,
    type SessionProviderErrorDiagnostics,
} from "@slopus/happy-providers";

const protectedSessions = new WeakSet<BaseSession>();

/** Selection-time inputs only. Never reads credentials, configuration or environment after failure. */
export class CredentialDiagnosticSources {
    readonly #values = new Set<string>();

    constructor(
        readonly providerId: string,
        hosts: readonly string[],
    ) {
        for (const host of hosts) this.add(host);
    }

    add(value: string | undefined): void {
        if (value !== undefined && value.trim().length > 0) this.#values.add(value);
    }

    configured(key: string, value: string | undefined): void {
        if (value !== undefined) this.add(`providers.${this.providerId}.${key}`);
    }

    path(value: string | undefined): void {
        if (value === undefined || value.trim().length === 0) return;
        this.add(value);
        this.add(resolve(value));
    }

    environment(name: string, value: string | undefined): void {
        if (value !== undefined && value.trim().length > 0) this.add(name);
    }

    snapshot(): CredentialDiagnosticSanitizer {
        return new CredentialDiagnosticSanitizer([...this.#values]);
    }
}

/** Exact matches with identifier boundaries; ordinary model output never enters this sanitizer. */
class CredentialDiagnosticSanitizer {
    readonly #pattern: RegExp | undefined;

    constructor(values: readonly string[]) {
        const alternatives = [...values]
            .filter((value) => value.trim().length > 0)
            .sort((left, right) => right.length - left.length)
            .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        this.#pattern =
            alternatives.length === 0
                ? undefined
                : new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives.join("|")})(?![A-Za-z0-9_])`, "g");
    }

    text(value: string): string {
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
        if (protectedSessions.has(session)) return session;
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
        protectedSessions.add(session);
        return session;
    }
}
