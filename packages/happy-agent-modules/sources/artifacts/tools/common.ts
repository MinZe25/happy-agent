import { Type, type Static } from "@sinclair/typebox";

import {
    artifactPathSchema,
    artifactRecordSchema,
    artifactTitleSchema,
    artifactTypeSchema,
    MAX_ARTIFACT_FILES,
    type ArtifactRecord,
} from "../Artifact.js";

/** The one capability every artifact tool contributes to the model's instructions. */
export const ARTIFACT_TOOL_CAPABILITY =
    "Publish Markdown documents and HTML pages with their images and other files, images, image series, videos, and documents as versioned artifacts, and list, read, update, and delete them.";

/**
 * How a model mentions an artifact in a reply. Clients replace the tag with the artifact's live
 * title as a link, and surfaces that cannot show links get the title as plain text.
 */
export const ARTIFACT_REFERENCE_INSTRUCTIONS =
    'When you mention an artifact in a reply, write its reference tag inline, such as <happy-artifact id="…"/> with the artifact\'s ID; add version="N" to point at one version. The artifact tools give you the exact tag. People see the artifact\'s current title as a link in its place, so do not repeat the title beside the tag or link the artifact yourself. A tag inside code stays literal.';

/** One file a call writes into an artifact. */
export const artifactToolFileSchema = Type.Object(
    {
        path: Type.Optional(
            Type.String({
                ...artifactPathSchema,
                description:
                    'Where the file sits in the artifact, such as "index.md" or "images/chart.png". Defaults to the type\'s entry for content and to the file\'s own name for fromPath.',
            }),
        ),
        content: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 16 * 1024 * 1024,
                description: "The file's whole text, such as Markdown, HTML, CSS, or a script",
            }),
        ),
        fromPath: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 4096,
                description:
                    "A file on your machine to copy in, such as an image you generated or a PDF",
            }),
        ),
    },
    { additionalProperties: false },
);

export const artifactToolFilesSchema = Type.Array(artifactToolFileSchema, {
    maxItems: MAX_ARTIFACT_FILES,
});

/** Where files go and how they relate, as every writing tool explains it. */
export const ARTIFACT_FILES_GUIDANCE = [
    "Every artifact version is a small tree of files. Each file has a path inside the artifact and comes either from content, its whole text, or from fromPath, a file on your machine such as an image you generated. A file's media type comes from its path's extension.",
    `A markdown artifact opens "index.md" and an html artifact opens "index.html"; put the pictures, styles, scripts, and other files they use beside them and refer to them with relative paths, such as ![Chart](images/chart.png) or <img src="img/hero.jpg">, which resolve without rewriting. An html page runs as it is, scripts included, in a sandbox that cannot reach this installation's data.`,
    "An html page sits on the surface of whatever shows it: leave html and body without a background and set color-scheme: light dark, so it reads in light and dark. Keep it flat, with spacing, hairline dividers, and type for hierarchy: no card inside a card or box inside a box, and no thick coloured stripe down the left edge of a card or callout. DESIGN.md beside the Happy Agent documentation README is the full design system.",
    'An html artifact can also be a live app: <script src="/api/v1/client.js"></script> gives it a key-value store shared by all its versions and everyone using it, with realtime changes, writes that survive network failures, and who the viewer is. Before building one, read recipe/artifact-apps.md beside the Happy Agent documentation README. Call the API only at absolute /api/... paths, and put no files under api/. Read and change the data of an app yourself with read_artifact_data and write_artifact_data. Before publishing, try the app with happy-agent artifact dev as a workspace service, as two people and with network faults; after publishing, read_artifact_logs shows the errors and sync problems its pages reported.',
    'Types: "markdown" and "html" (the entry plus up to 255 other files; entry up to 4 MiB and 16 MiB), "image" (one PNG, JPEG, GIF, WebP, AVIF, or SVG up to 32 MiB), "image_series" (1–64 images shown in path order, so number them like 01-intro.png), "video" (one MP4, WebM, QuickTime, or Ogg up to 256 MiB), and "document" (one PDF, Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV, or EPUB file up to 64 MiB). A version holds at most 256 MiB in all.',
].join("\n\n");

/** The card a chat shows for the version a writing call made, recorded with its result. */
const artifactToolPresentationSchema = Type.Object(
    {
        type: Type.Literal("artifact"),
        artifactId: artifactRecordSchema.properties.id,
        version: Type.Integer({ minimum: 1 }),
        artifactType: artifactTypeSchema,
        title: artifactTitleSchema,
    },
    { additionalProperties: false },
);

/** What a writing tool returns: the artifact, and the card the chat shows for it. */
export const artifactToolResultSchema = Type.Composite(
    [artifactRecordSchema, Type.Object({ presentation: artifactToolPresentationSchema })],
    { additionalProperties: false },
);

export type ArtifactToolResult = Static<typeof artifactToolResultSchema>;

/** The artifact as a writing call left it, with the card for its latest version. */
export function presentedArtifact(artifact: ArtifactRecord): ArtifactToolResult {
    return {
        ...artifact,
        presentation: {
            type: "artifact",
            artifactId: artifact.id,
            version: artifact.latestVersion,
            artifactType: artifact.type,
            title: artifact.title,
        },
    };
}

/** What a writing tool tells the model about the card the user now sees. */
export const ARTIFACT_PRESENTED_NOTICE =
    "The user now sees it in this chat as a card that opens it, so do not describe it as if they cannot see it. The card appears only in this chat's history, not in any parent or child chat; if a user should see it in another chat, the agent in that chat must mention or present it there.";
