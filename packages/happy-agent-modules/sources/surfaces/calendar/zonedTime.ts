/**
 * Wall-clock arithmetic in IANA time zones, built on the runtime's `Intl` time zone database.
 * Days are counted from 1970-01-01 so local dates compare and shift as plain integers.
 */

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A local date as days since 1970-01-01 and a time of day in milliseconds. */
export type LocalDateTime = { readonly day: number; readonly time: number };

/** Whether the runtime's time zone database recognizes this name; numeric offsets are not zones. */
export function isTimeZone(name: string): boolean {
    if (!/^[A-Za-z]/.test(name)) return false;
    try {
        formatter(name);
        return true;
    } catch {
        return false;
    }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
    let existing = formatters.get(timeZone);
    if (existing === undefined) {
        existing = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
        });
        formatters.set(timeZone, existing);
    }
    return existing;
}

/** The zone's offset from UTC at this instant, in milliseconds. */
export function offsetAt(instant: number, timeZone: string): number {
    const parts: Record<string, string> = {};
    for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
        parts[part.type] = part.value;
    }
    const local = Date.UTC(
        Number(parts["year"]),
        Number(parts["month"]) - 1,
        Number(parts["day"]),
        Number(parts["hour"]),
        Number(parts["minute"]),
        Number(parts["second"]),
    );
    // The formatter reads whole seconds, so compare against the instant's whole second.
    const whole = instant - (((instant % 1000) + 1000) % 1000);
    return local - whole;
}

/** The wall-clock date and time of an instant in a zone. */
export function toLocal(instant: number, timeZone: string): LocalDateTime {
    const local = instant + offsetAt(instant, timeZone);
    const day = Math.floor(local / DAY_MS);
    return { day, time: local - day * DAY_MS };
}

/**
 * The instant of a wall-clock time, with JavaScript Temporal's `compatible` disambiguation: a time
 * skipped by a forward jump moves forward by the jump, and a repeated time takes the earlier instant.
 */
export function fromLocal(local: LocalDateTime, timeZone: string): number {
    const wall = local.day * DAY_MS + local.time;
    // Offsets on either side of any transition near this wall-clock time.
    const before = offsetAt(wall - DAY_MS, timeZone);
    const after = offsetAt(wall + DAY_MS, timeZone);
    const candidates = [...new Set([before, after])]
        .map((offset) => wall - offset)
        .filter((instant) => toLocalMs(instant, timeZone) === wall)
        .sort((a, b) => a - b);
    if (candidates.length > 0) return candidates[0]!;
    // The wall-clock time was skipped: read it with the offset in force before the gap.
    return wall - before;
}

function toLocalMs(instant: number, timeZone: string): number {
    return instant + offsetAt(instant, timeZone);
}

/** `YYYY-MM-DD` to days since 1970-01-01, or undefined when the date does not exist. */
export function parseDate(text: string): number | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match === null) return undefined;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
    return Date.UTC(year, month - 1, day) / DAY_MS;
}

export function formatDate(day: number): string {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Year, month 1–12, and day of month of a day number. */
export function dateParts(day: number): { year: number; month: number; date: number } {
    const value = new Date(day * DAY_MS);
    return {
        year: value.getUTCFullYear(),
        month: value.getUTCMonth() + 1,
        date: value.getUTCDate(),
    };
}

export function dayFromParts(year: number, month: number, date: number): number {
    return Date.UTC(year, month - 1, date) / DAY_MS;
}

export function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 for Monday through 6 for Sunday; 1970-01-01 was a Thursday. */
export function weekdayOf(day: number): number {
    return (((day + 3) % 7) + 7) % 7;
}

export { DAY_MS };
