import { MAX_PROJECT_ORDER_KEY_LENGTH } from "../Project.js";
import { orderKeyBetween } from "../../utils/orderKeyBetween.js";

/** Shared decimal keys, preserving this catalog's existing storage bound. */
export function projectOrderKeyBetween(before: string | null, after: string | null): string {
    const key = orderKeyBetween(before, after);
    if (key.length > MAX_PROJECT_ORDER_KEY_LENGTH)
        throw new Error("Project agent order key space is exhausted.");
    return key;
}
