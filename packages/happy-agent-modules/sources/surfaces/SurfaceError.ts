import type { Todo } from "@slopus/happy-agent-client";

export class SurfaceError extends Error {
    constructor(
        readonly code: "invalid_request" | "not_found" | "conflict" | "forbidden",
        message: string,
        readonly todo?: Todo,
    ) {
        super(message);
    }
}
