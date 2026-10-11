import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Keep one snapshot under its digest. Content already there is the same content, so it is not
 * written again; new content lands under a temporary name and is published by rename, so a
 * reader never sees part of a file.
 */
export async function writeChatMediaContent(path: string, bytes: Uint8Array): Promise<void> {
    const existing = await stat(path).catch(() => undefined);
    if (existing?.isFile() === true && existing.size === bytes.byteLength) return;
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.tmp-${globalThis.crypto.randomUUID()}-${basename(path)}`);
    try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } catch (error: unknown) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
