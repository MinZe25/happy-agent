import { describe, expect, it } from "vitest";
import {
    projectEventDiagnostics,
    projectMessageDiagnostics,
} from "../../sources/api/projectCredentialDiagnostics.js";
import { diagnostic } from "../support/credentialDiagnostic.js";
import { credentialWriterRuntime } from "../support/credentialWriterRuntime.js";

const invalidErrors = [
    { name: "extra field", error: { ...diagnostic, privateField: "PRIVATE_OUT_OF_SCHEMA_SOURCE" } },
    {
        name: "oversized location",
        error: {
            ...diagnostic,
            credentialSource: {
                ...diagnostic.credentialSource!,
                location: "PRIVATE_OUT_OF_SCHEMA_SOURCE".repeat(20),
            },
        },
    },
];

describe.each(invalidErrors)("invalid diagnostic: $name", ({ error }) => {
    it("omits an invalid error rather than returning the unprojected source", () => {
        const message = { id: "failure", role: "service", content: [], error };
        const original = structuredClone(message);
        expect(projectMessageDiagnostics(message, false)).toEqual({
            id: "failure",
            role: "service",
            content: [],
        });
        expect(message).toEqual(original);
        expect(projectMessageDiagnostics(message, true)).toBe(message);
    });

    it("withholds the invalid error from a real member's journal pull", async () => {
        const fixture = await credentialWriterRuntime("member");
        try {
            const before = fixture.journal.cursor();
            const event = fixture.journal.append("message.created", {
                agentId: fixture.agent.id,
                message: {
                    id: "malformeddiagnostic",
                    role: "service",
                    content: [{ type: "text", text: "Retry this conversation." }],
                    at: Date.now(),
                    error,
                },
            });
            const original = structuredClone(event);
            const response = await fixture.reader.getEvents({ after: before });
            const delivered = response.events.find((entry) => entry.cursor === event.cursor);
            expect(delivered).toBeDefined();
            expect(delivered).not.toHaveProperty("payload.message.error");
            for (const marker of [
                "PRIVATE_OUT_OF_SCHEMA_SOURCE",
                "PRIVATE_PROVIDER_TOKEN",
                "private-login-host",
                "private-login-command",
            ])
                expect(JSON.stringify(delivered)).not.toContain(marker);
            expect(event).toEqual(original);
        } finally {
            await fixture.close();
        }
    }, 30_000);
});

it.each(["message.created", "message.updated"])(
    "strips sensitive keys from an unexpected %s payload",
    (type) => {
        const event = {
            type,
            cursor: "1:1",
            occurredAt: 1,
            payload: {
                message: [
                    {
                        error: diagnostic,
                        credentialSource: { location: "PRIVATE_ARRAY_SOURCE" },
                        safe: "kept",
                    },
                    {
                        nested: {
                            credential_source: "PRIVATE_SNAKE_SOURCE",
                            credentialSourceLocation: "PRIVATE_LOCATION_SOURCE",
                        },
                    },
                ],
                error: diagnostic,
                credentialSource: { location: "PRIVATE_ROOT_SOURCE" },
                safe: "ordinary payload",
            },
        };
        const original = structuredClone(event);
        expect(projectEventDiagnostics(event, false)).toEqual({
            ...event,
            payload: { message: [{ safe: "kept" }, { nested: {} }], safe: "ordinary payload" },
        });
        expect(event).toEqual(original);
        expect(projectEventDiagnostics(event, true)).toBe(event);
    },
);
