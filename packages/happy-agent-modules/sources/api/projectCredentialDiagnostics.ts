import { Type } from "@sinclair/typebox";
import { messageErrorSchema } from "@slopus/happy-agent-client";

import type { ApiEvent } from "./ApiEventJournal.js";
import { apiValidator } from "./impl/apiValidator.js";

const diagnosticMessageSchema = Type.Object({ error: messageErrorSchema });
const messagePayloadSchema = Type.Object({ message: Type.Record(Type.String(), Type.Unknown()) });

/** Project at delivery time; the durable record and shared journal stay caller-neutral. */
export function projectMessageDiagnostics(
    message: Record<string, unknown>,
    disclose: boolean,
): Record<string, unknown> {
    if (disclose || !apiValidator(diagnosticMessageSchema).Check(message)) return message;
    return {
        ...message,
        error: {
            ...message.error,
            credentialSource: null,
            recovery: {
                steps: [
                    "Retry this conversation. If it still fails, ask the person who manages this installation to check the selected provider.",
                ],
                actions: [...message.error.recovery.actions],
            },
        },
    };
}

/** No per-recipient variants are retained: every reader projects the immutable original. */
export function projectEventDiagnostics(event: ApiEvent, disclose: boolean): ApiEvent {
    if (
        disclose ||
        (event.type !== "message.created" && event.type !== "message.updated") ||
        !apiValidator(messagePayloadSchema).Check(event.payload)
    )
        return event;
    const message = projectMessageDiagnostics(event.payload.message, false);
    if (message === event.payload.message) return event;
    return { ...event, payload: { ...event.payload, message } };
}
