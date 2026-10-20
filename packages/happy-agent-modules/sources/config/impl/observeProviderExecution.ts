import { agentEffort, agentPermissionMode, agentServiceTier } from "@slopus/happy-agent-base";
import type { CredentialSource, ErrorRecovery, MessageMode } from "@slopus/happy-agent-client";
import {
    CodexSession,
    CodexSessionCredential,
    type BaseProvider,
    type BaseSession,
    type SessionEvent,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";
import type { ProviderExecutionObservations } from "./ProviderExecutionObservations.js";
import type { ProviderSignIn } from "./ProviderCredentialsUnavailableError.js";
import type { CredentialDiagnosticSanitizer } from "./credentialDiagnosticSanitizer.js";
import { nativeAccountIdentity } from "../persistence/nativeAccountIdentity.js";

const observedProviders = new WeakSet<BaseProvider>();
const observedSessions = new WeakMap<
    BaseSession,
    {
        diagnostics: CredentialDiagnosticSanitizer | undefined;
        descriptor: string;
        ambiguous: boolean;
    }
>();

/** Decorate the native instance in place so every session entry point has the same boundary. */
export function observeProviderExecution(
    provider: BaseProvider,
    observations: ProviderExecutionObservations,
    providerId: string,
    credentialSource: CredentialSource | null,
    recovery?: ErrorRecovery,
    providerType?: string,
    diagnostics?: CredentialDiagnosticSanitizer,
    signIn?: ProviderSignIn,
): BaseProvider {
    if (observedProviders.has(provider)) return provider;
    const createSession = provider.session.bind(provider);
    const descriptor = JSON.stringify({ providerId, providerType, credentialSource });
    provider.session = async (...args) => {
        const session = await createSession(...args);
        const existing = observedSessions.get(session);
        if (existing !== undefined) {
            // No supported native provider shares sessions between instances. If an adapter
            // does, the session cannot prove which instance's credentials it actually uses.
            const equal =
                existing.descriptor === descriptor &&
                (existing.diagnostics === undefined
                    ? diagnostics === undefined
                    : diagnostics !== undefined && existing.diagnostics.equivalent(diagnostics));
            if (!equal) existing.ambiguous = true;
            return session;
        }
        const observation = { diagnostics, descriptor, ambiguous: false };
        observedSessions.set(session, observation);
        const mode = (
            ctx: Context,
            request: { model?: string; effort?: string; serviceTier?: string },
            account: MessageMode["account"] = null,
        ): MessageMode | undefined =>
            request.model === undefined
                ? undefined
                : {
                      providerId,
                      modelId: request.model,
                      effort: request.effort ?? agentEffort(ctx) ?? "medium",
                      serviceTier: request.serviceTier ?? agentServiceTier(ctx) ?? null,
                      permissionMode: agentPermissionMode(ctx),
                      ...(providerType === undefined ? {} : { providerType, account }),
                  };
        const run = session.run.bind(session);
        // Preserve ordinary prototype method lookup for scripted adapters that replace their
        // implementation after construction. Existing own decorators remain the exact seam.
        const inheritedRun = Object.getOwnPropertyDescriptor(session, "run") === undefined;
        session.run = (ctx, request) => {
            // Capture once at entry, never look up the current operation when a late event lands.
            const handle = observations.claim(session.id, "inference");
            // This exact credential supplies the native HTTP and WebSocket account header.
            // Copy before any await; never reread mutable login files or provider metadata.
            const principal = nativePrincipal();
            let snapshot = mode(ctx, request);
            let prepared: Promise<void> | undefined;
            const prepare = async () => {
                const account =
                    handle === undefined || observation.ambiguous
                        ? null
                        : await nativeAccountIdentity(ctx, principal);
                if (snapshot !== undefined && providerType !== undefined)
                    snapshot = {
                        ...snapshot,
                        account: principal === nativePrincipal() ? account : null,
                    };
                if (handle !== undefined) {
                    if (observation.ambiguous) observations.discard(handle);
                    else if (snapshot !== undefined)
                        observations.activate(handle, {
                            mode: snapshot,
                            credentialSource,
                            ...(recovery === undefined ? {} : { recovery }),
                        });
                }
            };
            let recorded = false;
            const record = (
                errorCode?: string,
                failure: { resetsAt?: number; contextOverflow?: true } = {},
            ) => {
                if (recorded) return;
                recorded = true;
                if (handle !== undefined && observation.ambiguous) {
                    observations.discard(handle);
                    return;
                }
                if (handle !== undefined && snapshot !== undefined)
                    observations.record(handle, {
                        mode: snapshot,
                        credentialSource,
                        ...(recovery === undefined ? {} : { recovery }),
                        ...(errorCode === undefined ? {} : { errorCode }),
                        ...(errorCode === "authentication_failed" && signIn !== undefined
                            ? { signIn }
                            : {}),
                        ...failure,
                    });
            };
            let stream: ReturnType<BaseSession["run"]>;
            try {
                stream = inheritedRun
                    ? (Object.getPrototypeOf(session) as BaseSession).run.call(
                          session,
                          ctx,
                          request,
                      )
                    : run(ctx, request);
            } catch (error) {
                record();
                throw error;
            }
            return {
                [Symbol.asyncIterator]: () => {
                    const iterator = stream[Symbol.asyncIterator]();
                    const observe = async (
                        operation: () => Promise<IteratorResult<SessionEvent>>,
                    ): Promise<IteratorResult<SessionEvent>> => {
                        try {
                            // The native run is lazy. Resolve only local metadata before its first
                            // request, so the first output block already has the frozen identity.
                            await (prepared ??= prepare());
                            const result = await operation();
                            if (result.done) record();
                            else if (result.value.type === "done") {
                                const event = result.value;
                                record(
                                    event.state !== "error"
                                        ? undefined
                                        : event.providerError?.type === "authentication"
                                          ? "authentication_failed"
                                          : (event.providerError?.type ?? "inference_failed"),
                                    event.state !== "error"
                                        ? {}
                                        : {
                                              ...((event.providerError?.type === "out_of_tokens" ||
                                                  event.providerError?.type === "rate_limit") &&
                                              event.providerError.resetAt !== undefined
                                                  ? { resetsAt: event.providerError.resetAt }
                                                  : {}),
                                              ...(event.kind === "context_overflow"
                                                  ? { contextOverflow: true as const }
                                                  : {}),
                                          },
                                );
                            }
                            return result;
                        } catch (error) {
                            record();
                            throw error;
                        }
                    };
                    return {
                        next: (...input) => observe(() => iterator.next(...input)),
                        ...(iterator.return === undefined
                            ? {}
                            : {
                                  return: (value: unknown) =>
                                      observe(() => iterator.return!(value)),
                              }),
                        ...(iterator.throw === undefined
                            ? {}
                            : { throw: (error: unknown) => observe(() => iterator.throw!(error)) }),
                    };
                },
            };
        };
        const compact = session.compact.bind(session);
        session.compact = async (ctx, request) => {
            const handle = observations.claim(session.id, "compaction");
            const principal = nativePrincipal();
            const selected = mode(ctx, request);
            let account: MessageMode["account"] = null;
            try {
                if (handle !== undefined && !observation.ambiguous)
                    account = await nativeAccountIdentity(ctx, principal);
            } catch (error) {
                // Nothing reached the native provider. Release this claim even when a direct
                // factory caller has no daemon settlement hook to end the observation.
                if (handle !== undefined) observations.discard(handle);
                throw error;
            }
            const snapshot =
                selected === undefined || providerType === undefined
                    ? selected
                    : { ...selected, account: principal === nativePrincipal() ? account : null };
            try {
                return await compact(ctx, request);
            } finally {
                if (handle !== undefined && observation.ambiguous) observations.discard(handle);
                else if (handle !== undefined && snapshot !== undefined)
                    observations.record(handle, {
                        mode: snapshot,
                        credentialSource,
                        ...(recovery === undefined ? {} : { recovery }),
                    });
            }
        };
        return session;

        function nativePrincipal(): string | undefined {
            return providerType === "codex" &&
                session instanceof CodexSession &&
                session.credential instanceof CodexSessionCredential
                ? session.credential.credential.accountId
                : undefined;
        }
    };
    observedProviders.add(provider);
    return provider;
}
