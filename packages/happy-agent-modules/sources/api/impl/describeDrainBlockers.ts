/** One piece of work still holding a drain open, as the log names it. */
export interface DrainBlocker {
    /** A running tool's name, or the stage an agent is in when no tool is running. */
    readonly category: string;
    readonly startedAt: number | undefined;
}

/** The drain's blockers grouped by category, for a log line and for noticing change. */
export interface DrainBlockerSummary {
    /** Categories and counts only, so the passage of time alone is not a change. */
    readonly key: string;
    readonly text: string;
}

/**
 * Group what holds a drain open by category, oldest first, with the age of the oldest of each.
 *
 * Only names and ages are written. Arguments, commands, prompts, and output never reach the log.
 */
export function describeDrainBlockers(
    blockers: readonly DrainBlocker[],
    now: number,
): DrainBlockerSummary {
    const groups = new Map<string, { count: number; oldest: number | undefined }>();
    for (const blocker of blockers) {
        const group = groups.get(blocker.category) ?? { count: 0, oldest: undefined };
        group.count += 1;
        if (
            blocker.startedAt !== undefined &&
            (group.oldest === undefined || blocker.startedAt < group.oldest)
        ) {
            group.oldest = blocker.startedAt;
        }
        groups.set(blocker.category, group);
    }
    const sorted = [...groups.entries()].sort(
        ([leftName, left], [rightName, right]) =>
            (left.oldest ?? now) - (right.oldest ?? now) || leftName.localeCompare(rightName),
    );
    return {
        key: [...groups.entries()]
            .map(([category, group]) => `${category}:${String(group.count)}`)
            .sort()
            .join(","),
        text: sorted
            .map(
                ([category, group]) =>
                    `${category}x${String(group.count)}` +
                    (group.oldest === undefined
                        ? ""
                        : `@${String(Math.round(Math.max(0, now - group.oldest) / 1000))}s`),
            )
            .join(","),
    };
}
