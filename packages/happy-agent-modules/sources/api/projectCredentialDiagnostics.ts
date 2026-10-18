import { Type } from "@sinclair/typebox";
import {
    credentialSourceSchema,
    errorRecoveryCommandSchema,
    errorRecoverySchema,
    messageAccountSchema,
    messageErrorSchema,
    messageModeSchema,
} from "@slopus/happy-agent-client";

import type { ApiEvent } from "./ApiEventJournal.js";
import { apiValidator } from "./impl/apiValidator.js";

const closedSourceSchema = Type.Object(credentialSourceSchema.properties, {
    additionalProperties: false,
});
const closedModeSchema = Type.Object(
    {
        ...messageModeSchema.properties,
        account: Type.Optional(
            Type.Union([
                Type.Object(messageAccountSchema.properties, { additionalProperties: false }),
                Type.Null(),
            ]),
        ),
    },
    { additionalProperties: false },
);
const diagnosticMessageSchema = Type.Object({
    error: Type.Object(
        {
            ...messageErrorSchema.properties,
            mode: Type.Union([closedModeSchema, Type.Null()]),
            credentialSource: Type.Union([closedSourceSchema, Type.Null()]),
            recovery: Type.Object(
                {
                    ...errorRecoverySchema.properties,
                    commands: Type.Optional(
                        Type.Array(
                            Type.Object(errorRecoveryCommandSchema.properties, {
                                additionalProperties: false,
                            }),
                            { maxItems: 8 },
                        ),
                    ),
                },
                { additionalProperties: false },
            ),
        },
        { additionalProperties: false },
    ),
});
const messagePayloadSchema = Type.Object({ message: Type.Record(Type.String(), Type.Unknown()) });
const hasErrorSchema = Type.Object({ error: Type.Unknown() });
const objectSchema = Type.Record(Type.String(), Type.Unknown());
const arraySchema = Type.Array(Type.Unknown());

/** Project at delivery time; the durable record and shared journal stay caller-neutral. */
export function projectMessageDiagnostics(
    message: Record<string, unknown>,
    disclose: boolean,
): Record<string, unknown> {
    if (disclose) return message;
    if (!apiValidator(hasErrorSchema).Check(message)) return message;
    if (!apiValidator(diagnosticMessageSchema).Check(message)) {
        const { error: _error, ...safe } = message;
        return safe;
    }
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
    if (disclose || (event.type !== "message.created" && event.type !== "message.updated"))
        return event;
    if (!apiValidator(messagePayloadSchema).Check(event.payload)) {
        return { ...event, payload: stripUnexpectedDiagnostics(event.payload) };
    }
    const message = projectMessageDiagnostics(event.payload.message, false);
    if (message === event.payload.message) return event;
    return { ...event, payload: { ...event.payload, message } };
}

/** Malformed payloads cannot smuggle diagnostics around the ordinary message projection. */
function stripUnexpectedDiagnostics(value: unknown, depth = 0): unknown {
    // The journal already bounds event bytes; also bound traversal depth and fail closed.
    if (depth >= 64) return null;
    if (apiValidator(arraySchema).Check(value))
        return value.map((entry) => stripUnexpectedDiagnostics(entry, depth + 1));
    if (!apiValidator(objectSchema).Check(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(
                ([key]) =>
                    ![
                        "error",
                        "credentialSource",
                        "credential_source",
                        "credentialSourceLocation",
                    ].includes(key),
            )
            .map(([key, entry]) => [key, stripUnexpectedDiagnostics(entry, depth + 1)]),
    );
}
