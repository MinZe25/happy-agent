import type { CalendarRecurrence, CalendarTiming } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";
import {
    expandCalendarEvent,
    seriesBounds,
} from "../../../sources/surfaces/calendar/expandCalendarEvent.js";
import {
    formatToolDateTime,
    parseToolBoundary,
    parseToolDateTime,
} from "../../../sources/surfaces/calendar/calendarToolTime.js";
import { normalizeRecurrence } from "../../../sources/surfaces/calendar/validateCalendarSeries.js";
import { fromLocal, isTimeZone, parseDate } from "../../../sources/surfaces/calendar/zonedTime.js";

const BERLIN = "Europe/Berlin";
const DAY = 86_400_000;
const at = (text: string, zone = BERLIN) => parseToolDateTime(text, zone, "test");
const local = (instant: number, zone = BERLIN) => formatToolDateTime(instant, zone);
const rule = (input: Parameters<typeof normalizeRecurrence>[0]) =>
    normalizeRecurrence(input) as CalendarRecurrence;

function expand(
    timing: CalendarTiming,
    recurrence: CalendarRecurrence | null,
    from: string,
    to: string,
    view = BERLIN,
) {
    return expandCalendarEvent(
        "e",
        { timing, recurrence },
        parseToolBoundary(from, view, "from"),
        parseToolBoundary(to, view, "to"),
        view,
    );
}
const starts = (occurrences: ReturnType<typeof expand>, zone = BERLIN) =>
    occurrences.map((occurrence) =>
        occurrence.timing.kind === "timed"
            ? `${occurrence.index}@${local(occurrence.timing.start, zone)}`
            : `${occurrence.index}@${occurrence.timing.startDate}..${occurrence.timing.endDate}`,
    );
const timed = (start: string, end: string, timeZone = BERLIN): CalendarTiming => ({
    kind: "timed",
    start: at(start, timeZone),
    end: at(end, timeZone),
    timeZone,
});

describe("calendar time zones", () => {
    it("recognizes IANA names, including links, and rejects offsets", () => {
        expect(isTimeZone("Europe/Berlin")).toBe(true);
        expect(isTimeZone("UTC")).toBe(true);
        expect(isTimeZone("US/Eastern")).toBe(true);
        expect(isTimeZone("+02:00")).toBe(false);
        expect(isTimeZone("Mars/Olympus")).toBe(false);
    });

    it("moves skipped wall-clock times forward and takes the earlier repeated instant", () => {
        // Berlin skips 02:00–03:00 on 29 March 2026 and repeats 02:00–03:00 on 25 October.
        expect(local(at("2026-03-29T02:30"))).toBe("2026-03-29T03:30:00+02:00");
        expect(local(at("2026-10-25T02:30"))).toBe("2026-10-25T02:30:00+02:00");
        expect(local(at("2026-10-25T02:30+01:00"))).toBe("2026-10-25T02:30:00+01:00");
        expect(() => at("2026-07-01T09:00+01:00")).toThrow(/does not use/);
        expect(local(at("2026-07-01T09:00:05.250"))).toBe("2026-07-01T09:00:05.250+02:00");
        expect(local(at("2026-07-01T09:00Z", "UTC"), "UTC")).toBe("2026-07-01T09:00:00+00:00");
        expect(() => at("2026-02-30T09:00")).toThrow();
        expect(fromLocal({ day: parseDate("2026-07-01")!, time: 0 }, "UTC")).toBe(
            Date.UTC(2026, 6, 1),
        );
    });
});

describe("calendar recurrence expansion", () => {
    it("keeps the wall-clock time of a weekly meeting across the end of daylight saving", () => {
        const occurrences = expand(
            timed("2026-10-12T09:00", "2026-10-12T10:00"),
            rule({ frequency: "weekly" }),
            "2026-10-15",
            "2026-11-03",
        );
        expect(starts(occurrences)).toEqual([
            "1@2026-10-19T09:00:00+02:00",
            "2@2026-10-26T09:00:00+01:00",
            "3@2026-11-02T09:00:00+01:00",
        ]);
        for (const occurrence of occurrences)
            if (occurrence.timing.kind === "timed")
                expect(occurrence.timing.end - occurrence.timing.start).toBe(3_600_000);
        // The instant moves by an hour so the local time stays put.
        const [before, after] = occurrences.map((o) =>
            o.timing.kind === "timed" ? o.timing.start : 0,
        );
        expect(after! - before!).toBe(7 * DAY + 3_600_000);
    });

    it("moves an occurrence in the spring gap forward and keeps the earlier instant in the autumn overlap", () => {
        const daily = rule({ frequency: "daily" });
        expect(
            starts(
                expand(
                    timed("2026-03-27T02:30", "2026-03-27T03:00"),
                    daily,
                    "2026-03-28",
                    "2026-03-31",
                ),
            ),
        ).toEqual([
            "1@2026-03-28T02:30:00+01:00",
            "2@2026-03-29T03:30:00+02:00",
            "3@2026-03-30T02:30:00+02:00",
        ]);
        expect(
            starts(
                expand(
                    timed("2026-10-24T02:30", "2026-10-24T03:00"),
                    daily,
                    "2026-10-25",
                    "2026-10-26",
                ),
            ),
        ).toEqual(["1@2026-10-25T02:30:00+02:00"]);
    });

    it("skips months without the start's day and numbers only real occurrences", () => {
        const occurrences = expand(
            { kind: "allDay", startDate: "2026-01-31", endDate: "2026-02-01" },
            rule({ frequency: "monthly" }),
            "2026-01-01",
            "2026-04-01",
        );
        expect(starts(occurrences)).toEqual([
            "0@2026-01-31..2026-02-01",
            "1@2026-03-31..2026-04-01",
        ]);
        expect(
            starts(
                expand(
                    { kind: "allDay", startDate: "2026-01-31", endDate: "2026-02-01" },
                    rule({ frequency: "monthly", count: 3 }),
                    "2026-04-01",
                    "2026-07-01",
                ),
            ),
        ).toEqual(["2@2026-05-31..2026-06-01"]);
    });

    it("repeats 29 February only in leap years", () => {
        const leap = { kind: "allDay", startDate: "2024-02-29", endDate: "2024-03-01" } as const;
        expect(
            starts(expand(leap, rule({ frequency: "yearly" }), "2025-01-01", "2025-04-01")),
        ).toEqual([]);
        expect(
            starts(expand(leap, rule({ frequency: "yearly" }), "2028-02-01", "2028-04-01")),
        ).toEqual(["1@2028-02-29..2028-03-01"]);
    });

    it("ends at an inclusive until date or after count occurrences", () => {
        const start = timed("2026-06-01T08:00", "2026-06-01T08:30");
        expect(
            starts(
                expand(
                    start,
                    rule({ frequency: "daily", until: "2026-06-03" }),
                    "2026-06-01",
                    "2026-06-10",
                ),
            ),
        ).toHaveLength(3);
        expect(
            starts(
                expand(
                    start,
                    rule({ frequency: "daily", interval: 2, count: 3 }),
                    "2026-06-01",
                    "2026-06-30",
                ),
            ),
        ).toEqual([
            "0@2026-06-01T08:00:00+02:00",
            "1@2026-06-03T08:00:00+02:00",
            "2@2026-06-05T08:00:00+02:00",
        ]);
    });

    it("counts an off-pattern weekly start as occurrence 0 and honours the week interval", () => {
        // 2026-10-20 is a Tuesday; the rule lists Monday and Wednesday every other week.
        const occurrences = expand(
            { kind: "allDay", startDate: "2026-10-20", endDate: "2026-10-21" },
            rule({ frequency: "weekly", interval: 2, weekdays: ["wednesday", "monday"] }),
            "2026-10-19",
            "2026-11-12",
        );
        expect(starts(occurrences)).toEqual([
            "0@2026-10-20..2026-10-21",
            "1@2026-10-21..2026-10-22",
            "2@2026-11-02..2026-11-03",
            "3@2026-11-04..2026-11-05",
        ]);
        expect(rule({ frequency: "weekly", weekdays: ["sunday", "monday"] })).toEqual({
            frequency: "weekly",
            interval: 1,
            weekdays: ["monday", "sunday"],
            until: null,
            count: null,
        });
    });

    it("jumps far into an endless series with the right occurrence numbers", () => {
        // 2026-10-19 begins week 2963 after Monday 1970-01-05: 2 occurrences in week 0, then 2 a week.
        const occurrences = expand(
            timed("1970-01-05T12:00", "1970-01-05T13:00", "UTC"),
            rule({ frequency: "weekly", weekdays: ["monday", "friday"] }),
            "2026-10-19",
            "2026-10-24",
            "UTC",
        );
        expect(starts(occurrences, "UTC")).toEqual([
            "5926@2026-10-19T12:00:00+00:00",
            "5927@2026-10-23T12:00:00+00:00",
        ]);
        const daily = expand(
            timed("1970-01-01T00:00", "1970-01-01T01:00", "UTC"),
            rule({ frequency: "daily" }),
            "2026-10-19",
            "2026-10-20",
            "UTC",
        );
        expect(daily.map((o) => o.index)).toEqual([20_745]);
    });

    it("places all-day occurrences by the viewer's midnight and includes ones already running", () => {
        const trip = { kind: "allDay", startDate: "2026-10-18", endDate: "2026-10-23" } as const;
        // The range starts at Berlin midnight of the 20th; the trip began two days earlier.
        expect(starts(expand(trip, null, "2026-10-20", "2026-10-21"))).toEqual([
            "0@2026-10-18..2026-10-23",
        ]);
        // The trip ends at each viewer's midnight: later than Berlin's in Los Angeles, earlier in Tokyo.
        const range = (zone: string) =>
            expandCalendarEvent(
                "e",
                { timing: trip, recurrence: null },
                parseToolBoundary("2026-10-23", BERLIN, "from"),
                parseToolBoundary("2026-10-23T06:00", BERLIN, "to"),
                zone,
            ).length;
        expect(range(BERLIN)).toBe(0);
        expect(range("America/Los_Angeles")).toBe(1);
        expect(range("Asia/Tokyo")).toBe(0);
    });

    it("keeps index 0 at the event's own instant, even in a repeated hour", () => {
        const second = at("2026-10-25T02:30+01:00");
        const occurrences = expandCalendarEvent(
            "e",
            {
                timing: { kind: "timed", start: second, end: second + 600_000, timeZone: BERLIN },
                recurrence: rule({ frequency: "daily" }),
            },
            second - DAY,
            second + DAY + 3_600_000,
            BERLIN,
        );
        expect(occurrences[0]).toMatchObject({ index: 0, timing: { start: second } });
    });

    it("bounds every series conservatively for the range query", () => {
        const timing = timed("2026-01-31T09:00", "2026-01-31T10:00");
        expect(seriesBounds({ timing, recurrence: null })).toEqual({
            lower: timing.kind === "timed" ? timing.start - 2 * DAY : 0,
            upper: (parseDate("2026-01-31")! + 1) * DAY + 3_600_000 + 2 * DAY,
        });
        expect(seriesBounds({ timing, recurrence: rule({ frequency: "monthly" }) }).upper).toBe(
            null,
        );
        expect(
            seriesBounds({ timing, recurrence: rule({ frequency: "monthly", count: 2 }) }).upper,
        ).toBe((parseDate("2026-03-31")! + 1) * DAY + 3_600_000 + 2 * DAY);
    });
});
