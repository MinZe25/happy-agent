import type { SurfaceDocument } from "@slopus/happy-agent-client";
import { SurfaceError } from "./SurfaceError.js";

export class SurfaceDocumentConflictError extends SurfaceError {
    constructor(readonly document: SurfaceDocument) {
        super("conflict", "The document has changed.");
    }
}
