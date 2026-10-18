/** Owner snapshots decide membership/order; each nested agent keeps its own newest UUIDv7 version. */
export function mergeOwnerAgents<T extends { readonly id: string; readonly version: string }>(
    incoming: readonly T[],
    known: Map<string, T>,
): T[] {
    return incoming.map((agent) => {
        const previous = known.get(agent.id);
        const newest =
            previous !== undefined && previous.version > agent.version ? previous : agent;
        known.set(agent.id, structuredClone(newest));
        return structuredClone(newest);
    });
}
