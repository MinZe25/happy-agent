import type { MessageError } from "@slopus/happy-agent-client";
import type { ProviderExecutionAttempt } from "../../config/index.js";

/** Typed provider classification only: never infer authentication from the displayed error text. */
export function executionFailure(attempt: ProviderExecutionAttempt | undefined): MessageError {
    return {
        code: attempt?.errorCode ?? "inference_failed",
        mode: attempt?.mode ?? null,
        credentialSource: attempt?.credentialSource ?? null,
        recovery:
            attempt?.errorCode === "authentication_failed" && attempt.recovery !== undefined
                ? attempt.recovery
                : {
                      steps: [
                          "Retry this conversation. If it still fails, ask the person who manages this installation to check the selected provider.",
                      ],
                      actions: ["ask_chief"],
                  },
    };
}
