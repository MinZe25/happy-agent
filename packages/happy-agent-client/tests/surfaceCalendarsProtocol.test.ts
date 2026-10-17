import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    calendarEventCreatedPayloadSchema,
    calendarEventUpdatedPayloadSchema,
} from "../sources/protocol/events.js";
import {
    calendarEventRevisionSchema,
    calendarEventSchema,
    calendarEventVersionListResponseSchema,
    calendarRangeResponseSchema,
    calendarRecurrenceInputSchema,
    calendarRecurrenceSchema,
    createCalendarEventRequestSchema,
    createSurfaceRequestSchema,
    updateCalendarEventRequestSchema,
    type CalendarEvent,
    type CalendarEventRevision,
} from "../sources/protocol/surfaces.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const now = 1_755_400_000_000;
const surfaceId = "s12345678901234567890123";
const event: CalendarEvent = {
    id: "e4k8m2q9w1e5r7y3u6i0o2p4",
    surfaceId,
    authorUserId: "u1x2y3z4a5b6c7d8e9f0g1h2",
    title: "Team sync",
    notes: "Agenda\n- one",
    location: "Room 4",
    timing: {
        kind: "timed",
        start: 1_760_943_600_000,
        end: 1_760_947_200_000,
        timeZone: "Europe/Berlin",
    },
    recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: ["monday", "thursday"],
        until: null,
        count: 10,
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version,
};
const revision: CalendarEventRevision = {
    event,
    actor: { userId: "u1x2y3z4a5b6c7d8e9f0g1h2", agentId: null },
    source: "api",
};

describe("calendar Surface protocol", () => {
    it("creates calendar Surfaces with the shared catalog fields and advertises them in health", () => {
        expect(
            Value.Check(createSurfaceRequestSchema, {
                type: "calendar",
                name: "Team",
                id: surfaceId,
                image: { data: "AAAA" },
                mutationId: "create",
            }),
        ).toBe(true);
        expect(
            Value.Check(createSurfaceRequestSchema, { type: "calendar", name: "Team", text: "" }),
        ).toBe(false);
        const health = Value.Check(healthResponseSchema.properties.capabilities, {
            calendarSurfaces: true,
        });
        expect(health).toBe(true);
    });

    it("models timed and all-day series records with tombstones and blank titles", () => {
        expect(Value.Check(calendarEventSchema, event)).toBe(true);
        expect(
            Value.Check(calendarEventSchema, {
                ...event,
                title: "",
                notes: null,
                location: null,
                timing: { kind: "allDay", startDate: "2026-10-20", endDate: "2026-10-21" },
                recurrence: null,
                status: "deleted",
                deletedAt: now,
            }),
        ).toBe(true);
        expect(Value.Check(calendarEventSchema, { ...event, title: "   " })).toBe(true);
        expect(Value.Check(calendarEventSchema, { ...event, title: "a\nb" })).toBe(false);
        expect(Value.Check(calendarEventSchema, { ...event, title: "x".repeat(1025) })).toBe(false);
        expect(Value.Check(calendarEventSchema, { ...event, location: " " })).toBe(false);
        expect(Value.Check(calendarEventSchema, { ...event, notes: "" })).toBe(false);
        expect(Value.Check(calendarEventSchema, { ...event, deletedAt: now })).toBe(false);
        expect(
            Value.Check(calendarEventSchema, { ...event, status: "deleted", deletedAt: null }),
        ).toBe(false);
        expect(
            Value.Check(calendarEventSchema, {
                ...event,
                timing: { ...event.timing, timeZone: "+02:00" },
            }),
        ).toBe(false);
        expect(
            Value.Check(calendarEventSchema, {
                ...event,
                timing: { kind: "allDay", startDate: "2026-13-01", endDate: "2026-10-21" },
            }),
        ).toBe(false);
    });

    it("keeps weekdays to weekly rules and fills every rule field in responses", () => {
        expect(
            Value.Check(calendarRecurrenceSchema, {
                frequency: "monthly",
                interval: 1,
                until: "2027-06-30",
                count: null,
            }),
        ).toBe(true);
        expect(Value.Check(calendarRecurrenceSchema, { frequency: "monthly", interval: 1 })).toBe(
            false,
        );
        expect(Value.Check(calendarRecurrenceInputSchema, { frequency: "monthly" })).toBe(true);
        expect(
            Value.Check(calendarRecurrenceInputSchema, {
                frequency: "daily",
                weekdays: ["monday"],
            }),
        ).toBe(false);
        expect(
            Value.Check(calendarRecurrenceInputSchema, {
                frequency: "weekly",
                weekdays: ["monday", "monday"],
            }),
        ).toBe(false);
        expect(
            Value.Check(calendarRecurrenceInputSchema, { frequency: "weekly", interval: 1001 }),
        ).toBe(false);
        expect(
            Value.Check(calendarRecurrenceInputSchema, { frequency: "weekly", count: 10_001 }),
        ).toBe(false);
    });

    it("requires only timing to create and at least one editable field to update", () => {
        expect(Value.Check(createCalendarEventRequestSchema, { timing: event.timing })).toBe(true);
        expect(Value.Check(createCalendarEventRequestSchema, { title: "x" })).toBe(false);
        expect(
            Value.Check(createCalendarEventRequestSchema, {
                timing: event.timing,
                authorUserId: null,
            }),
        ).toBe(false);
        expect(
            Value.Check(createCalendarEventRequestSchema, {
                timing: event.timing,
                status: "deleted",
            }),
        ).toBe(false);
        expect(Value.Check(updateCalendarEventRequestSchema, { mutationId: "m" })).toBe(false);
        expect(Value.Check(updateCalendarEventRequestSchema, {})).toBe(false);
        expect(Value.Check(updateCalendarEventRequestSchema, { title: "" })).toBe(true);
        expect(Value.Check(updateCalendarEventRequestSchema, { notes: null })).toBe(true);
        expect(Value.Check(updateCalendarEventRequestSchema, { recurrence: null })).toBe(true);
        expect(Value.Check(updateCalendarEventRequestSchema, { status: "active" })).toBe(true);
        expect(Value.Check(updateCalendarEventRequestSchema, { status: "completed" })).toBe(false);
        expect(
            Value.Check(updateCalendarEventRequestSchema, {
                timing: { ...event.timing, extra: 1 },
            }),
        ).toBe(false);
        // A revision's editable fields are accepted verbatim, so any earlier state restores.
        const { title, notes, location, timing, recurrence, status } = revision.event;
        expect(
            Value.Check(updateCalendarEventRequestSchema, {
                title,
                notes,
                location,
                timing,
                recurrence,
                status,
            }),
        ).toBe(true);
    });

    it("carries range reads, revisions, and shared events", () => {
        expect(
            Value.Check(calendarRangeResponseSchema, {
                events: [event],
                occurrences: [{ eventId: event.id, index: 3, timing: event.timing }],
                truncated: false,
                cursor: "1",
            }),
        ).toBe(true);
        expect(Value.Check(calendarEventRevisionSchema, revision)).toBe(true);
        expect(
            Value.Check(calendarEventVersionListResponseSchema, {
                versions: [revision],
                nextAfterVersion: null,
            }),
        ).toBe(true);
        expect(
            Value.Check(calendarEventCreatedPayloadSchema, { event, mutationId: "create" }),
        ).toBe(true);
        expect(
            Value.Check(calendarEventUpdatedPayloadSchema, {
                surfaceId,
                eventId: event.id,
                previousVersion: version,
                version: nextVersion,
                changes: { timing: event.timing, recurrence: null, updatedAt: now },
            }),
        ).toBe(true);
        expect(
            Value.Check(calendarEventUpdatedPayloadSchema, {
                surfaceId,
                eventId: event.id,
                previousVersion: version,
                version: nextVersion,
                changes: { title: "" },
            }),
        ).toBe(false);
    });

    it("uses the calendar prefix, encodes identities, and sends version guards", async () => {
        const requests: { method: string; url: string; body: unknown; ifMatch: string | null }[] =
            [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                method: init?.method ?? "GET",
                url: input.toString(),
                body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                ifMatch: new Headers(init?.headers).get("if-match"),
            });
            return new Response(JSON.stringify({ event }), { status: 200 });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        await client.listCalendarEvents(surfaceId, {
            from: 1_759_269_600_000,
            to: 1_761_951_600_000,
            timeZone: "Europe/Berlin",
        });
        await client.createCalendarEvent(surfaceId, { id: event.id, timing: event.timing });
        await client.getCalendarEvent(surfaceId, "event/1");
        await client.updateCalendarEvent(surfaceId, event.id, { title: "" }, { ifMatch: version });
        await client.deleteCalendarEvent(surfaceId, event.id, {
            ifMatch: nextVersion,
            mutationId: "delete",
        });
        await client.listCalendarEventVersions(surfaceId, event.id, {
            afterVersion: version,
            limit: 2,
        });
        await client.getCalendarEventVersion(surfaceId, event.id, "version/1");

        const base = `http://agent.local/v0/surfaces/calendar/${surfaceId}`;
        expect(requests).toEqual([
            {
                method: "GET",
                url: `${base}?from=1759269600000&to=1761951600000&timeZone=Europe%2FBerlin`,
                body: null,
                ifMatch: null,
            },
            {
                method: "POST",
                url: base,
                body: { id: event.id, timing: event.timing },
                ifMatch: null,
            },
            { method: "GET", url: `${base}/event%2F1`, body: null, ifMatch: null },
            {
                method: "PATCH",
                url: `${base}/${event.id}`,
                body: { title: "" },
                ifMatch: version,
            },
            {
                method: "DELETE",
                url: `${base}/${event.id}`,
                body: { mutationId: "delete" },
                ifMatch: nextVersion,
            },
            {
                method: "GET",
                url: `${base}/${event.id}/versions?afterVersion=${version}&limit=2`,
                body: null,
                ifMatch: null,
            },
            {
                method: "GET",
                url: `${base}/${event.id}/versions/version%2F1`,
                body: null,
                ifMatch: null,
            },
        ]);
    });

    it("exposes the current event on conflicts without retrying", async () => {
        let calls = 0;
        const fetch: typeof globalThis.fetch = async () => {
            calls += 1;
            return new Response(
                JSON.stringify({
                    error: "The calendar event has changed.",
                    code: "conflict",
                    currentVersion: nextVersion,
                    event: { ...event, version: nextVersion },
                }),
                { status: 409 },
            );
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const error = await client
            .updateCalendarEvent(surfaceId, event.id, { title: "x" }, { ifMatch: version })
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: nextVersion, event: { ...event, version: nextVersion } },
        });
        expect(calls).toBe(1);
    });
});
