import type { VoiceConfig } from "@slopus/happy-agent-client";

/** Readable voice settings for an admin bot; the prompt itself is quoted only when overridden. */
export function describeVoiceSettings(voice: VoiceConfig): string {
    const stored = voice.controller;
    const effective = voice.effectiveController;
    return [
        `Stored controller: account ${stored.providerId ?? "default"}, model ${stored.modelId ?? "default"}, effort ${stored.effort ?? "default"}, fast mode ${stored.fastMode ? "on" : "off"}.`,
        `A call starting now uses ${effective.modelId} at ${effective.effort} effort on ${effective.providerId ?? "no enabled account"}${effective.serviceTier === null ? "" : ` with the ${effective.serviceTier} service tier`}.`,
        ...(effective.notice === null ? [] : [`Notice: ${effective.notice}`]),
        voice.systemPromptOverride === null
            ? "The voice model uses its built-in prompt."
            : `The voice model uses this prompt instead of its built-in one:\n${voice.systemPromptOverride}`,
    ].join("\n");
}
