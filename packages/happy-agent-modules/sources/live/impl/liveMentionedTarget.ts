import type { LiveDesktopTarget } from "@slopus/happy-agent-client";
import { liveAppStateEntities, type LiveAppStateView } from "./liveAppState.js";

/**
 * The one sidebar entity a request names exactly, as whole words regardless of case. Names along a
 * single path ("Garden notes in Observatory") resolve to the deepest; anything else is ambiguous.
 */
export function liveMentionedTarget(
    view: LiveAppStateView,
    text: string,
): LiveDesktopTarget | undefined {
    const spoken = ` ${words(text)} `;
    if (spoken.trim() === "") return undefined;
    const matches = liveAppStateEntities(view).filter((entity) => {
        const name = words(entity.name);
        return name.length >= 3 && spoken.includes(` ${name} `);
    });
    // A matched name inside a longer matched name is part of it: "Garden" within "Garden notes".
    const specific = matches.filter(
        (entity) =>
            !matches.some(
                (other) =>
                    words(other.name) !== words(entity.name) &&
                    ` ${words(other.name)} `.includes(` ${words(entity.name)} `),
            ),
    );
    const deepest = specific.reduce<(typeof specific)[number] | undefined>(
        (best, entity) =>
            best === undefined || entity.path.length > best.path.length ? entity : best,
        undefined,
    );
    if (deepest === undefined) return undefined;
    const onPath = specific.every(
        (entity) =>
            entity.key === deepest.key ||
            (entity.path.length < deepest.path.length &&
                entity.path.every((part, index) => deepest.path[index] === part)),
    );
    return onPath ? deepest.target : undefined;
}

function words(text: string): string {
    return text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}
