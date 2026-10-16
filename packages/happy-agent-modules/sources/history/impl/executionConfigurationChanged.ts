import type { MessageMode } from "@slopus/happy-agent-client";

/** Labels and unknown account provenance are enrichment, not evidence of an execution change. */
export function executionConfigurationChanged(before: MessageMode, after: MessageMode): boolean {
    return (
        before.providerId !== after.providerId ||
        before.modelId !== after.modelId ||
        before.effort !== after.effort ||
        before.serviceTier !== after.serviceTier ||
        before.permissionMode !== after.permissionMode ||
        (before.account != null && after.account != null && before.account.id !== after.account.id)
    );
}
