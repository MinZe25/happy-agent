/**
 * The reference tag a model writes in a reply so clients show the artifact's live title as a link
 * to it, as `packages/happy-agent/API.md` specifies under "Reference tags". Artifact IDs are
 * CUID2s, so they always fit the tag's grammar.
 */
export function artifactReferenceTag(artifactId: string, version?: number): string {
    return version === undefined
        ? `<happy-artifact id="${artifactId}"/>`
        : `<happy-artifact id="${artifactId}" version="${String(version)}"/>`;
}
