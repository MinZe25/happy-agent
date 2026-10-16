import type { MessageMode } from "@slopus/happy-agent-client";

/** Project a validated composer input before any module can persist or execute it. */
export function requestedAgentMode(
    mode: MessageMode,
): Omit<MessageMode, "account" | "providerType"> {
    return {
        providerId: mode.providerId,
        modelId: mode.modelId,
        effort: mode.effort,
        serviceTier: mode.serviceTier,
        permissionMode: mode.permissionMode,
    };
}
