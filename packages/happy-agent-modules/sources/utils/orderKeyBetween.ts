const ORDER_DIGITS = "0123456789";

/** Existing catalog decimal fractional keys, compared lexicographically; null means either end. */
export function orderKeyBetween(before: string | null, after: string | null): string {
    const lower = before ?? "";
    if (after !== null && lower >= after) throw new Error("Order keys are out of order.");
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const low = index < lower.length ? lower.charCodeAt(index) - 48 : 0;
        const high = after !== null && index < after.length ? after.charCodeAt(index) - 48 : 10;
        if (high - low > 1) return `${prefix}${ORDER_DIGITS[low + Math.floor((high - low) / 2)]!}`;
        if (high - low === 1)
            return `${prefix}${ORDER_DIGITS[low]!}${orderKeyAbove(lower.slice(index + 1))}`;
        prefix += ORDER_DIGITS[low]!;
    }
}

function orderKeyAbove(rest: string): string {
    let prefix = "";
    for (let index = 0; ; index += 1) {
        const digit = index < rest.length ? rest.charCodeAt(index) - 48 : 0;
        if (digit < 9) return `${prefix}${ORDER_DIGITS[digit + Math.floor((10 - digit) / 2)]!}`;
        prefix += "9";
    }
}
