export { orderKeyBetween as surfaceOrderKey } from "../../utils/orderKeyBetween.js";

export function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
