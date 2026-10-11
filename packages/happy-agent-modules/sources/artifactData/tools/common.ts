import { Type } from "@sinclair/typebox";

import {
    artifactDataEntrySchema,
    type ArtifactDataEntry,
    type ArtifactDataUser,
} from "../ArtifactData.js";

/** The one capability both artifact data tools contribute to the model's instructions. */
export const ARTIFACT_DATA_TOOL_CAPABILITY =
    "Read and change the live data that HTML artifact apps share between their viewers.";

/** An author a model reads beside an entry: who they are, by name and kind. */
export const artifactDataAuthorViewSchema = Type.Object(
    {
        id: Type.String(),
        kind: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
        name: Type.Union([Type.String(), Type.Null()]),
    },
    { additionalProperties: false },
);

export const artifactDataEntriesResultSchema = Type.Array(artifactDataEntrySchema);

export function authorViews(users: readonly ArtifactDataUser[]) {
    return users.map((user) => ({ id: user.id, kind: user.kind, name: user.name }));
}

/** One entry as a model reads it, with its value as JSON text cut at `maxValueBytes`. */
export function formatArtifactDataEntry(
    entry: ArtifactDataEntry,
    authors: ReadonlyMap<string, { readonly kind: string; readonly name: string | null }>,
    maxValueBytes: number,
): string {
    const author = authors.get(entry.updatedBy);
    const by =
        author === undefined
            ? `someone (${entry.updatedBy})`
            : `${author.name ?? (author.kind === "agent" ? "an agent" : "a person")} (${author.kind} ${entry.updatedBy})`;
    const when = new Date(entry.updatedAt).toISOString();
    const head = `- ${JSON.stringify(entry.key)} · version ${entry.version} · ${entry.deleted ? "deleted" : "written"} ${when} by ${by}`;
    if (entry.deleted) return head;
    const json = JSON.stringify(entry.value);
    const bytes = Buffer.from(json, "utf8");
    if (bytes.byteLength <= maxValueBytes) return `${head}\n  ${json}`;
    const cut = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.subarray(0, maxValueBytes))
        .replace(/\uFFFD$/, "");
    return `${head}\n  ${cut}… [value cut at ${String(maxValueBytes)} of ${String(bytes.byteLength)} bytes; read this key alone to see more]`;
}
