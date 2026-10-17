import type { CalendarEvent, Todo } from "@slopus/happy-agent-client";

export class SurfaceError extends Error {
    constructor(
        readonly code:
            | "invalid_request"
            | "not_found"
            | "conflict"
            | "forbidden"
            | "not_initialized",
        message: string,
        /** The authoritative record a conflict reports, under the key its route uses. */
        readonly current?: { readonly todo: Todo } | { readonly event: CalendarEvent },
    ) {
        super(message);
    }
}
