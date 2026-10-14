import type { Workspace } from "../Workspace.js";

export { orderKeyBetween } from "../../utils/orderKeyBetween.js";

export function lowestOrderKey(workspaces: readonly Workspace[]): string | null {
    const sorted = [...workspaces].sort(byOrder);
    return sorted[0]?.orderKey ?? null;
}

export function byOrder(left: Workspace, right: Workspace): number {
    if (left.orderKey === right.orderKey) return left.id < right.id ? -1 : 1;
    return left.orderKey < right.orderKey ? -1 : 1;
}
