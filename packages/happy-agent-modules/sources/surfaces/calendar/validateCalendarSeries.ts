import type {
    CalendarRecurrence,
    CalendarRecurrenceInput,
    CalendarTiming,
} from "@slopus/happy-agent-client";
import { SurfaceError } from "../SurfaceError.js";
import { CALENDAR_WEEKDAYS, seriesStartDay } from "./expandCalendarEvent.js";
import { isTimeZone, parseDate } from "./zonedTime.js";

const MAX_DURATION_DAYS = 366;
const MAX_DURATION_MS = MAX_DURATION_DAYS * 86_400_000;

/** The stored form of a rule: every field present and weekdays in Monday-first order. */
export function normalizeRecurrence(
    input: CalendarRecurrenceInput | null | undefined,
): CalendarRecurrence | null {
    if (input === null || input === undefined) return null;
    const ends = {
        interval: input.interval ?? 1,
        until: input.until ?? null,
        count: input.count ?? null,
    };
    if (input.frequency !== "weekly") return { frequency: input.frequency, ...ends };
    const weekdays = input.weekdays ?? null;
    return {
        frequency: "weekly",
        ...ends,
        weekdays:
            weekdays === null ? null : CALENDAR_WEEKDAYS.filter((day) => weekdays.includes(day)),
    };
}

/** Check a whole series after a creation or an edit; every message tells the caller how to fix it. */
export function validateCalendarSeries(
    timing: CalendarTiming,
    recurrence: CalendarRecurrence | null,
): void {
    if (timing.kind === "timed") {
        if (!isTimeZone(timing.timeZone))
            throw invalid(
                `${JSON.stringify(timing.timeZone)} is not a recognized IANA time zone, such as Europe/Berlin or UTC.`,
            );
        if (timing.end <= timing.start) throw invalid("A timed event must end after it starts.");
        if (timing.end - timing.start > MAX_DURATION_MS)
            throw invalid(`An event lasts at most ${MAX_DURATION_DAYS} days.`);
    } else {
        const start = parseDate(timing.startDate);
        const end = parseDate(timing.endDate);
        if (start === undefined || end === undefined)
            throw invalid("An all-day event's dates must be real calendar dates.");
        if (end <= start)
            throw invalid(
                "An all-day event's endDate is exclusive and must be after startDate: a one-day event on 2026-10-20 has endDate 2026-10-21.",
            );
        if (end - start > MAX_DURATION_DAYS)
            throw invalid(`An event lasts at most ${MAX_DURATION_DAYS} days.`);
    }
    if (recurrence === null) return;
    if (recurrence.until !== null && recurrence.count !== null)
        throw invalid("A recurrence ends by until or by count, not both.");
    if (recurrence.until !== null) {
        const until = parseDate(recurrence.until);
        if (until === undefined) throw invalid("The recurrence until date must be a real date.");
        if (until < seriesStartDay(timing))
            throw invalid(
                "The recurrence until date is before the event's start date. Change the rule together with the timing.",
            );
    }
}

function invalid(message: string): SurfaceError {
    return new SurfaceError("invalid_request", message);
}
