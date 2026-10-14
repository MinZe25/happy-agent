import { describe, expect, it } from "vitest";
import { orderKeyBetween } from "../../sources/utils/orderKeyBetween.js";
import { orderKeyBetween as workspaceKey } from "../../sources/workspaces/store/workspaceOrdering.js";
import { taskOrderKeyBetween } from "../../sources/tasks/impl/taskOrderKeyBetween.js";
import { connectionOrderKeyBetween } from "../../sources/connections/impl/connectionOrderKey.js";
import { subtaskOrderKeyBetween } from "../../sources/subtasks/subtaskOrderKeyBetween.js";
import { surfaceOrderKey } from "../../sources/surfaces/impl/surfaceOrderKey.js";
import { projectOrderKeyBetween } from "../../sources/projects/store/projectRootAgentOrdering.js";

describe("one decimal fractional ordering implementation", () => {
    it("keeps existing domain entry points on the same function", () => {
        for (const key of [
            workspaceKey,
            taskOrderKeyBetween,
            connectionOrderKeyBetween,
            subtaskOrderKeyBetween,
            surfaceOrderKey,
        ])
            expect(key).toBe(orderKeyBetween);
    });
    it.each([
        [null, null, "5"],
        ["5", null, "7"],
        ["7", null, "8"],
        ["8", null, "9"],
        ["9", null, "95"],
        ["5", "7", "6"],
        ["5", "6", "55"],
        ["55", "6", "57"],
        [null, "1", "05"],
        ["00000000000000000010", "00000000000000000011", "000000000000000000105"],
    ])("uses existing keys between %s and %s", (before, after, expected) => {
        expect(orderKeyBetween(before, after)).toBe(expected);
        expect(projectOrderKeyBetween(before, after)).toBe(expected);
    });
    it("inserts among mixed padded integer and fractional keys without rewriting neighbours", () => {
        const keys = ["00000000000000000001", "00000000000000000002", "5", "7"];
        const originals = [...keys];
        for (let step = 0; step < 500; step++) {
            const index = (step * 31) % (keys.length + 1);
            const before = keys[index - 1] ?? null;
            const after = keys[index] ?? null;
            const key = orderKeyBetween(before, after);
            expect(key).toMatch(/^[0-9]*[1-9]$/);
            if (before !== null) expect(key > before).toBe(true);
            if (after !== null) expect(key < after).toBe(true);
            keys.splice(index, 0, key);
        }
        expect(keys).toEqual([...keys].sort());
        for (const key of originals) expect(keys).toContain(key);
    });
});
