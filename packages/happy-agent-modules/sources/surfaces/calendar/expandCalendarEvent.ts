import type {
    CalendarOccurrence,
    CalendarRecurrence,
    CalendarTiming,
    CalendarWeekday,
} from "@slopus/happy-agent-client";
import {
    DAY_MS,
    dateParts,
    dayFromParts,
    daysInMonth,
    formatDate,
    fromLocal,
    parseDate,
    toLocal,
    weekdayOf,
} from "./zonedTime.js";

export const CALENDAR_WEEKDAYS: readonly CalendarWeekday[] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
/** The last instant and the last date an occurrence may reach: the end of year 9999. */
export const CALENDAR_MAX_INSTANT = 253_402_300_799_999;
const MAX_DAY = (CALENDAR_MAX_INSTANT + 1) / DAY_MS;

/** The series-defining parts of an event. */
export type CalendarSeries = {
    readonly timing: CalendarTiming;
    readonly recurrence: CalendarRecurrence | null;
};

/** An occurrence with the instant it starts at for ordering; all-day starts at view midnight. */
export type PlacedOccurrence = CalendarOccurrence & { readonly sortStart: number };

/** The event's local start date, as days since 1970-01-01. */
export function seriesStartDay(timing: CalendarTiming): number {
    return timing.kind === "timed"
        ? toLocal(timing.start, timing.timeZone).day
        : parseDate(timing.startDate)!;
}

/**
 * The occurrence dates of a series in order, with their zero-based indexes, from the first one on
 * or after `fromDay`. Index 0 is always the start date. Stops at the rule's `until` or `count`.
 */
export function* occurrenceDays(
    startDay: number,
    recurrence: CalendarRecurrence | null,
    fromDay: number,
): Generator<{ day: number; index: number }> {
    if (recurrence === null) {
        if (startDay >= fromDay) yield { day: startDay, index: 0 };
        return;
    }
    const until = recurrence.until === null ? MAX_DAY - 1 : parseDate(recurrence.until)!;
    const count = recurrence.count ?? Number.POSITIVE_INFINITY;
    for (const next of candidates(startDay, recurrence, fromDay)) {
        if (next.day > until || next.day >= MAX_DAY || next.index >= count) return;
        if (next.day >= fromDay) yield next;
    }
}

function* candidates(
    startDay: number,
    recurrence: CalendarRecurrence,
    fromDay: number,
): Generator<{ day: number; index: number }> {
    const { interval } = recurrence;
    if (recurrence.frequency === "daily") {
        let k = Math.max(0, Math.ceil((fromDay - startDay) / interval));
        for (;;) {
            yield { day: startDay + k * interval, index: k };
            k += 1;
        }
    }
    if (recurrence.frequency === "weekly") {
        const listed =
            recurrence.weekdays === null
                ? [weekdayOf(startDay)]
                : recurrence.weekdays.map((name) => CALENDAR_WEEKDAYS.indexOf(name));
        const monday = startDay - weekdayOf(startDay);
        const firstWeek = listed.filter((weekday) => monday + weekday > startDay);
        const firstWeekCount = 1 + firstWeek.length;
        const weekOfFrom = Math.floor((fromDay - monday) / 7);
        let period = Math.max(0, Math.ceil(weekOfFrom / interval));
        if (period === 0) {
            yield { day: startDay, index: 0 };
            for (const [offset, weekday] of firstWeek.entries())
                yield { day: monday + weekday, index: 1 + offset };
            period = 1;
        }
        for (;;) {
            const base = firstWeekCount + (period - 1) * listed.length;
            const weekStart = monday + period * interval * 7;
            for (const [offset, weekday] of listed.entries())
                yield { day: weekStart + weekday, index: base + offset };
            period += 1;
        }
    }
    // Monthly and yearly skip periods without the start's day; counting them needs the walk.
    const start = dateParts(startDay);
    const months = recurrence.frequency === "monthly" ? interval : interval * 12;
    let index = 0;
    for (let k = 0; ; k += 1) {
        const total = start.month - 1 + k * months;
        const year = start.year + Math.floor(total / 12);
        const month = (total % 12) + 1;
        if (year > 9999) return;
        if (start.date > daysInMonth(year, month)) continue;
        yield { day: dayFromParts(year, month, start.date), index };
        index += 1;
    }
}

/**
 * Every occurrence of a series that overlaps the instant range `[from, to)`. Timed occurrences keep
 * the start's local wall-clock time in the event's zone and last exactly as long as the event;
 * all-day occurrences cover midnight to midnight in `viewTimeZone`.
 */
export function expandCalendarEvent(
    eventId: string,
    series: CalendarSeries,
    from: number,
    to: number,
    viewTimeZone: string,
): PlacedOccurrence[] {
    const { timing, recurrence } = series;
    const occurrences: PlacedOccurrence[] = [];
    if (timing.kind === "timed") {
        const duration = timing.end - timing.start;
        const local = toLocal(timing.start, timing.timeZone);
        const lowDay = toLocal(Math.max(0, from - duration), timing.timeZone).day - 1;
        const highDay = toLocal(to, timing.timeZone).day + 1;
        for (const { day, index } of occurrenceDays(local.day, recurrence, lowDay)) {
            if (day > highDay) break;
            const start =
                index === 0 ? timing.start : fromLocal({ day, time: local.time }, timing.timeZone);
            const end = start + duration;
            if (end > CALENDAR_MAX_INSTANT + 1) break;
            if (start < to && end > from)
                occurrences.push({
                    eventId,
                    index,
                    timing: { kind: "timed", start, end, timeZone: timing.timeZone },
                    sortStart: start,
                });
        }
        return occurrences;
    }
    const startDay = parseDate(timing.startDate)!;
    const span = parseDate(timing.endDate)! - startDay;
    const lowDay = toLocal(from, viewTimeZone).day - span - 1;
    const highDay = toLocal(to, viewTimeZone).day + 1;
    for (const { day, index } of occurrenceDays(startDay, recurrence, lowDay)) {
        if (day > highDay || day + span > MAX_DAY) break;
        const start = fromLocal({ day, time: 0 }, viewTimeZone);
        const end = fromLocal({ day: day + span, time: 0 }, viewTimeZone);
        if (start < to && end > from)
            occurrences.push({
                eventId,
                index,
                timing: {
                    kind: "allDay",
                    startDate: formatDate(day),
                    endDate: formatDate(day + span),
                },
                sortStart: start,
            });
    }
    return occurrences;
}

/** Range order: start, all-day before timed at the same start, event ID, then index. */
export function compareOccurrences(a: PlacedOccurrence, b: PlacedOccurrence): number {
    return (
        a.sortStart - b.sortStart ||
        (a.timing.kind === b.timing.kind ? 0 : a.timing.kind === "allDay" ? -1 : 1) ||
        (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0) ||
        a.index - b.index
    );
}

/**
 * Conservative instant bounds of everything a series can ever cover, padded by two days so any
 * view zone falls inside them. `null` as the upper bound means the series never ends.
 */
export function seriesBounds(series: CalendarSeries): { lower: number; upper: number | null } {
    const pad = 2 * DAY_MS;
    const { timing, recurrence } = series;
    const startDay = seriesStartDay(timing);
    const lengthMs =
        timing.kind === "timed"
            ? timing.end - timing.start
            : (parseDate(timing.endDate)! - startDay) * DAY_MS;
    const lower = (timing.kind === "timed" ? timing.start : startDay * DAY_MS) - pad;
    let lastDay = startDay;
    if (recurrence !== null) {
        if (recurrence.until !== null) lastDay = parseDate(recurrence.until)!;
        else if (recurrence.count === null) return { lower, upper: null };
        else for (const { day } of occurrenceDays(startDay, recurrence, startDay)) lastDay = day;
    }
    return { lower, upper: (lastDay + 1) * DAY_MS + lengthMs + pad };
}
