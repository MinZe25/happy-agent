import type { MessageError } from "@slopus/happy-agent-client";

import { NATIVE_SIGN_IN, type NativeSignInVendor } from "./nativeSignIn.js";

/** How the person signs in again: the native product and, for its default login, the command. */
export interface ProviderSignIn {
    readonly product: string | null;
    readonly command: string | null;
}

/**
 * A configured provider found no credential to construct with, so every request through it will
 * fail the same way until a person restores one; retrying cannot help.
 *
 * The message reaches every reader — agents, collaboration reports, team members — as one short
 * sentence. Only the vendor's own default sign-in names its login command (API.md allows that one
 * exception); a configured, isolated, or Bedrock source says to check its settings. `signIn` feeds
 * the typed `signin_missing` failure and `failure` the legacy owner-only details for older clients.
 */
export class ProviderCredentialsUnavailableError extends Error {
    readonly signIn: ProviderSignIn;
    readonly failure: MessageError;

    constructor(
        readonly providerId: string,
        vendor: NativeSignInVendor | "bedrock",
        /** Only the vendor's own default sign-in was consulted, so its login command is the fix. */
        defaultNativeLogin: boolean,
    ) {
        const native = vendor === "bedrock" ? undefined : NATIVE_SIGN_IN[vendor];
        const command = native !== undefined && defaultNativeLogin ? native.command : null;
        super(
            native !== undefined && command !== null
                ? `${native.product} isn't signed in. Run ${command}, then retry.`
                : `${providerId} has no credentials. Check its settings, then retry.`,
        );
        this.name = "ProviderCredentialsUnavailableError";
        // As on the 401 path, only the default login is named; a custom source is fixed in its
        // own settings.
        this.signIn = { product: command === null ? null : native!.product, command };
        this.failure = {
            code: "credentials_unavailable",
            mode: null,
            credentialSource: null,
            recovery: {
                steps: [
                    command === null
                        ? "Restore the credentials this provider is configured to use on the machine running Happy Agent, then retry."
                        : `Run ${command} on the machine running Happy Agent, then retry.`,
                ],
                actions: ["ask_chief"],
                // API.md: the default native Claude Code login alone receives a copyable command.
                ...(vendor === "claude" && command !== null
                    ? { commands: [{ label: "Sign in to Claude Code", command }] }
                    : {}),
            },
        };
    }
}
