import { artifactUrlSchema } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import { ArtifactInputError, type ArtifactRecord } from "../Artifact.js";

/** Parse without fetching. Only a normalized HTTP(S) address without credentials is published. */
export function normalizeArtifactUrl(url: string): string {
    let address: URL;
    try {
        address = new URL(url);
    } catch {
        throw new ArtifactInputError(`${JSON.stringify(url)} is not a URL.`);
    }
    if (address.protocol !== "http:" && address.protocol !== "https:") {
        throw new ArtifactInputError("Only http and https pages can be live artifacts.");
    }
    if (address.username !== "" || address.password !== "") {
        throw new ArtifactInputError("A live artifact cannot carry a user name or password.");
    }
    if (!Value.Check(artifactUrlSchema, address.href)) {
        throw new ArtifactInputError(
            "The live URL must be a valid address of at most 4,096 characters.",
        );
    }
    return address.href;
}

/** One fixed compatibility entry; metadata changes never need to write content. */
export const LIVE_ARTIFACT_FALLBACK =
    '<!doctype html>\n<html><head><meta charset="utf-8"><title>Live page</title></head><body><p>This is a live page. Open it in a newer Happy client.</p></body></html>\n';

export function requireFileArtifact(artifact: ArtifactRecord): void {
    if (artifact.live !== undefined) {
        throw new ArtifactInputError(
            "This artifact's content is a live URL. Change its URL with update_artifact; its fallback files cannot be edited.",
        );
    }
}
