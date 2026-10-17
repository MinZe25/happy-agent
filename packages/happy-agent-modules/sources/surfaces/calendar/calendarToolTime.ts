import type { CalendarTiming, CalendarTimingInput } from "@slopus/happy-agent-client";
import { SurfaceError } from "../SurfaceError.js";
import { DAY_MS, fromLocal, isTimeZone, offsetAt, parseDate } from "./zonedTime.js";

/** A local wall-clock date-time with an optional offset that must agree with its zone. */
export const LOCAL_DATE_TIME_PATTERN =
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})?$";

/** The timing a model writes: timed values as local date-times in the named zone. */
export type ToolTimingInput =
    | { kind: "timed"; start: string; end: string; timeZone: string }
    | Extract<CalendarTimingInput, { kind: "allDay" }>;

/** The timing a model reads: timed values as local date-times with their offsets. */
export type ToolTiming =
    | { kind: "timed"; start: string; end: string; timeZone: string }
    | Extract<CalendarTiming, { kind: "allDay" }>;

/** The instant a model's local date-time names in `timeZone`. */
export function parseToolDateTime(text: string, timeZone: string, field: string): number {
    requireZone(timeZone);
    const match =
        /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))?$/.exec(
            text,
        );
    const day = match === null ? undefined : parseDate(match[1]!);
    if (match === null || day === undefined)
        throw invalid(
            `${field} must be a local date-time such as 2026-10-20T09:00 in ${timeZone}.`,
        );
    const [hour, minute, second] = [Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
    const millisecond = Number((match[5] ?? "0").padEnd(3, "0"));
    if (hour > 23 || minute > 59 || second > 59)
        throw invalid(`${field} has an impossible time of day.`);
    const wall = { day, time: ((hour * 60 + minute) * 60 + second) * 1000 + millisecond };
    if (match[6] === undefined) return fromLocal(wall, timeZone);
    const offset =
        match[6] === "Z"
            ? 0
            : (match[7] === "-" ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9])) * 60_000;
    const instant = wall.day * DAY_MS + wall.time - offset;
    if (offsetAt(instant, timeZone) !== offset)
        throw invalid(
            `${field} has offset ${match[6]}, which ${timeZone} does not use at that time. Omit the offset or use the zone's own.`,
        );
    return instant;
}

/** A range boundary: a local date meaning its midnight, or a local date-time. */
export function parseToolBoundary(text: string, timeZone: string, field: string): number {
    requireZone(timeZone);
    if (!text.includes("T")) {
        const day = parseDate(text);
        if (day === undefined)
            throw invalid(`${field} must be a date such as 2026-10-20 or a local date-time.`);
        return fromLocal({ day, time: 0 }, timeZone);
    }
    return parseToolDateTime(text, timeZone, field);
}

/** An instant as a local date-time in `timeZone` with its offset, such as 2026-10-20T09:00:00+02:00. */
export function formatToolDateTime(instant: number, timeZone: string): string {
    const offset = offsetAt(instant, timeZone);
    const local = new Date(instant + offset).toISOString();
    const time = local.endsWith(".000Z") ? local.slice(0, 19) : local.slice(0, 23);
    const minutes = Math.abs(offset) / 60_000;
    const sign = offset < 0 ? "-" : "+";
    return `${time}${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function toolTimingToApi(timing: ToolTimingInput): CalendarTimingInput {
    if (timing.kind === "allDay") return timing;
    return {
        kind: "timed",
        start: parseToolDateTime(timing.start, timing.timeZone, "start"),
        end: parseToolDateTime(timing.end, timing.timeZone, "end"),
        timeZone: timing.timeZone,
    };
}

/** Timing as a model reads it; timed values are written in `writtenIn`, by default the event's zone. */
export function apiTimingToTool(timing: CalendarTiming, writtenIn?: string): ToolTiming {
    if (timing.kind === "allDay") return timing;
    const zone = writtenIn ?? timing.timeZone;
    return {
        kind: "timed",
        start: formatToolDateTime(timing.start, zone),
        end: formatToolDateTime(timing.end, zone),
        timeZone: timing.timeZone,
    };
}

function requireZone(timeZone: string): void {
    if (!isTimeZone(timeZone))
        throw invalid(
            `${JSON.stringify(timeZone)} is not a recognized IANA time zone, such as Europe/Berlin or UTC.`,
        );
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function invalid(message: string): SurfaceError {
    return new SurfaceError("invalid_request", message);
}
