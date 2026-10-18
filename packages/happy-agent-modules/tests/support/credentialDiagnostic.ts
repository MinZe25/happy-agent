import type { ConfigurationBlock, MessageError } from "@slopus/happy-agent-client";

/** Canonical records exercise disclosure independently of the future provider-attempt writer. */
export const diagnostic: MessageError = {
    code: "authentication_failed",
    mode: {
        providerId: "work-account",
        providerType: "claude",
        account: null,
        modelId: "anthropic/sonnet-5-5",
        effort: "high",
        serviceTier: null,
        permissionMode: "auto",
    },
    credentialSource: {
        kind: "environment",
        location: "PRIVATE_PROVIDER_TOKEN",
        host: "private-login-host",
    },
    recovery: {
        steps: ["Update PRIVATE_PROVIDER_TOKEN on private-login-host, then retry."],
        actions: ["ask_chief"],
        commands: [{ label: "Sign in manually", command: "private-login-command" }],
    },
};

export const diagnosticText =
    "The provider could not authenticate this request.\n\nRetry the same conversation.";

export const diagnosticMessage = {
    role: "error" as const,
    recordId: "diagnostic-message",
    runId: "diagnostic-run",
    at: 100,
    blocks: [{ type: "text" as const, text: diagnosticText }],
    error: diagnostic,
};

export const configuration: ConfigurationBlock = {
    type: "configuration",
    before: null,
    after: {
        ...diagnostic.mode!,
        account: { id: "private-account-id", label: "Private account label" },
    },
    beforeMessageId: null,
};
