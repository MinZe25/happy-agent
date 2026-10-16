import { defineAgentTool } from "@slopus/happy-agent-base";
import { voiceConfigPatchSchema, voiceConfigSchema } from "@slopus/happy-agent-client";
import type { LiveModule } from "../LiveModule.js";
import { describeVoiceSettings } from "./describeVoiceSettings.js";

export function setVoiceSettingsTool(live: LiveModule, agentId: string) {
    return defineAgentTool({
        name: "set_voice_settings",
        defer: true,
        capabilities: ["Read and change this installation's voice settings."],
        searchKeywords: ["voice", "voice controller", "voice model", "voice prompt", "fast mode"],
        description:
            "Change this Happy Agent installation's voice settings for calls that start afterwards. `controller` may set `providerId` (a configured account or account pool), `modelId` (a model that account offers), `effort` (one that model accepts), and `fastMode`; `systemPrompt` replaces the voice model's prompt. Omitted properties are unchanged. `null` removes the runtime override and falls back to the machine-file value or built-in default. A prompt identical to the built-in prompt also removes the runtime override. Only active admin bots may use it.",
        parameters: voiceConfigPatchSchema,
        returnType: voiceConfigSchema,
        // Applying the same settings again is harmless.
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: (patch) =>
            `changing this Happy Agent installation's voice settings (${
                [
                    ...(patch.controller === undefined ? [] : ["controller"]),
                    ...(patch.systemPrompt === undefined ? [] : ["voice prompt"]),
                ].join(" and ") || "no changes"
            }). Access: installation-wide configuration write`,
        execute: async (ctx, patch) => await live.updateVoiceSettingsForAdmin(ctx, agentId, patch),
        toLLM: (result) => [{ type: "text", text: describeVoiceSettings(result) }],
    });
}
