import { createHash } from "node:crypto";

/** Namespace inbox identity by authenticated source, independent of session or request identity. */
export function stableId(value: string): string {
    return `p${createHash("sha256").update(value).digest("hex").slice(0, 23)}`;
}
