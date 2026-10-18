import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    mobileConnectorResponseSchema,
    mobileConnectorSchema,
    mobileConnectorUpdatedPayloadSchema,
    mobilePairingRequestSchema,
    type HappyAgentEvent,
    type MobileConnector,
} from "../sources/index.js";

const verifying: MobileConnector = {
    status: "open",
    pairing: {
        id: "pq7xk2m9r4t8w1y5z3a6b0c2",
        status: "verifying",
        qr: null,
        expiresAt: 1_755_400_420_000,
        device: { name: "Steve's iPhone", platform: "ios" },
        emoji: ["🐶", "🎸", "🍕", "🚀"],
        desktopConfirmed: false,
        mobileConfirmed: true,
        error: null,
    },
    devices: [
        {
            id: "dv3n8k1m5q9r2t6w0y4z7a1c",
            name: "Steve's iPhone",
            platform: "ios",
            createdAt: 1_755_400_000_000,
            lastSeenAt: 1_755_400_300_000,
        },
    ],
    error: null,
    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    updatedAt: 1_755_400_300_000,
};

function recordingClient(body: unknown) {
    const requests: { method: string; url: string; body: string | null }[] = [];
    const client = new HappyAgentClient({
        endpoint: "http://agent.local",
        token: "t",
        fetch: async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            return Response.json(body);
        },
    });
    return { client, requests };
}

describe("mobile connector protocol", () => {
    it("accepts the specified snapshot through every stage", () => {
        expect(Value.Check(mobileConnectorSchema, verifying)).toBe(true);
        const waiting: MobileConnector = {
            ...verifying,
            pairing: {
                ...verifying.pairing!,
                status: "waiting",
                qr: "happy://direct?eyJ2IjoxfQ",
                device: null,
                emoji: null,
                mobileConfirmed: false,
            },
            devices: [],
        };
        expect(Value.Check(mobileConnectorSchema, waiting)).toBe(true);
        const failed: MobileConnector = {
            ...verifying,
            status: "failed",
            error: "The phone connection socket did not open.",
            pairing: {
                ...verifying.pairing!,
                status: "failed",
                error: "The phone connection socket did not open.",
            },
        };
        expect(Value.Check(mobileConnectorSchema, failed)).toBe(true);
        expect(
            Value.Check(mobileConnectorSchema, { ...verifying, pairing: null, status: "disabled" }),
        ).toBe(true);
        expect(Value.Check(mobileConnectorSchema, { ...verifying, status: "paired" })).toBe(false);
        expect(
            Value.Check(mobileConnectorSchema, {
                ...verifying,
                pairing: { ...verifying.pairing, emoji: ["🐶"] },
            }),
        ).toBe(false);
        expect(Value.Check(mobilePairingRequestSchema, { pairingId: "x" })).toBe(true);
        expect(Value.Check(mobilePairingRequestSchema, {})).toBe(false);
    });

    it("types the owner-only update event as a complete replacement", () => {
        const event: HappyAgentEvent = {
            cursor: "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
            type: "mobile_connector.updated",
            occurredAt: verifying.updatedAt,
            payload: { mobileConnector: verifying },
        };
        expect(Value.Check(mobileConnectorUpdatedPayloadSchema, event.payload)).toBe(true);
    });

    it("calls the desktop routes and returns the snapshot", async () => {
        const { client, requests } = recordingClient({ mobileConnector: verifying });
        const responses = [
            await client.getMobileConnector(),
            await client.startMobilePairing(),
            await client.confirmMobilePairing("pq7xk2m9r4t8w1y5z3a6b0c2"),
            await client.cancelMobilePairing("pq7xk2m9r4t8w1y5z3a6b0c2"),
            await client.removeMobileDevice("dv3n8k1m5q9r2t6w0y4z7a1c"),
        ];
        for (const response of responses) {
            expect(Value.Check(mobileConnectorResponseSchema, response)).toBe(true);
        }
        expect(requests).toEqual([
            { method: "GET", url: "http://agent.local/v0/mobile-connector", body: null },
            { method: "POST", url: "http://agent.local/v0/mobile-connector/pairing", body: null },
            {
                method: "POST",
                url: "http://agent.local/v0/mobile-connector/pairing/confirm",
                body: JSON.stringify({ pairingId: "pq7xk2m9r4t8w1y5z3a6b0c2" }),
            },
            {
                method: "POST",
                url: "http://agent.local/v0/mobile-connector/pairing/cancel",
                body: JSON.stringify({ pairingId: "pq7xk2m9r4t8w1y5z3a6b0c2" }),
            },
            {
                method: "DELETE",
                url: "http://agent.local/v0/mobile-connector/devices/dv3n8k1m5q9r2t6w0y4z7a1c",
                body: null,
            },
        ]);
    });
});
