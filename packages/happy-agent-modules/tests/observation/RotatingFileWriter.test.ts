import { mkdtemp, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RotatingFileWriter } from "../../sources/observation/impl/RotatingFileWriter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function temporaryFile(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-observation-writer-"));
    temporaryDirectories.push(root);
    return join(root, name);
}

describe("RotatingFileWriter", () => {
    it.skipIf(process.platform === "win32")(
        "does not require chmod support for an already-private log",
        async () => {
            const path = await temporaryFile("agent.log");
            await writeFile(path, "old\n", { mode: 0o600 });
            const handle = await filesystem.open(path, "a");
            const prototype = Object.getPrototypeOf(handle);
            await handle.close();
            const chmod = vi
                .spyOn(prototype, "chmod")
                .mockRejectedValue(new Error("chmod unavailable"));
            const writer = await RotatingFileWriter.open({
                path,
                maxBytes: 1024,
                maxPendingBytes: 1024,
            });
            writer.write("new");
            await writer.close();
            expect(chmod).not.toHaveBeenCalled();
            expect(await readFile(path, "utf8")).toBe("old\nnew\n");
        },
    );

    it.skipIf(process.platform === "win32")(
        "closes an insecure log without writing when its permissions cannot be tightened",
        async () => {
            const path = await temporaryFile("agent.log");
            await writeFile(path, "old\n", { mode: 0o644 });
            const handle = await filesystem.open(path, "a");
            const prototype = Object.getPrototypeOf(handle);
            await handle.close();
            const chmod = vi
                .spyOn(prototype, "chmod")
                .mockRejectedValueOnce(new Error("Permission denied"));
            await expect(
                RotatingFileWriter.open({ path, maxBytes: 1024, maxPendingBytes: 1024 }),
            ).rejects.toThrow("Permission denied");
            expect((chmod.mock.contexts[0] as FileHandle).fd).toBe(-1);
            expect(await readFile(path, "utf8")).toBe("old\n");
        },
    );

    it.skipIf(process.platform === "win32")(
        "verifies that a successful chmod actually made the log private",
        async () => {
            const path = await temporaryFile("agent.log");
            await writeFile(path, "old\n", { mode: 0o644 });
            const handle = await filesystem.open(path, "a");
            const prototype = Object.getPrototypeOf(handle);
            await handle.close();
            const chmod = vi.spyOn(prototype, "chmod").mockResolvedValueOnce(undefined);
            await expect(
                RotatingFileWriter.open({ path, maxBytes: 1024, maxPendingBytes: 1024 }),
            ).rejects.toThrow("could not be made private");
            expect((chmod.mock.contexts[0] as FileHandle).fd).toBe(-1);
            expect(await readFile(path, "utf8")).toBe("old\n");
        },
    );
    it.skipIf(process.platform === "win32")(
        "keeps existing and rotated local logs readable only by their owner",
        async () => {
            const path = await temporaryFile("agent.log");
            await writeFile(path, "old\n", { mode: 0o644 });
            const writer = await RotatingFileWriter.open({
                path,
                maxBytes: 12,
                maxPendingBytes: 1024,
            });
            expect((await stat(path)).mode & 0o777).toBe(0o600);
            writer.write("replacement");
            await writer.close();
            expect((await stat(path)).mode & 0o777).toBe(0o600);
            expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
        },
    );
    it("appends whole lines in the order they were written", async () => {
        const path = await temporaryFile("agent.log");
        const writer = await RotatingFileWriter.open({
            maxBytes: 1_048_576,
            maxPendingBytes: 1_048_576,
            path,
        });

        writer.write("first");
        writer.write("second\n");
        writer.write("third");
        await writer.close();

        expect(await readFile(path, "utf8")).toBe("first\nsecond\nthird\n");
    });

    it("creates the directory it was pointed at", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-observation-writer-nested-"));
        temporaryDirectories.push(root);
        const path = join(root, "observation", "history", "agent.log");

        const writer = await RotatingFileWriter.open({
            maxBytes: 1_048_576,
            maxPendingBytes: 1_048_576,
            path,
        });
        writer.write("present");
        await writer.close();

        expect(await readFile(path, "utf8")).toBe("present\n");
    });

    it("keeps one previous generation rather than growing without bound", async () => {
        const path = await temporaryFile("agent.log");
        const writer = await RotatingFileWriter.open({
            maxBytes: 12,
            maxPendingBytes: 1_048_576,
            path,
        });

        writer.write("aaaaaaaaa"); // 10 bytes with its newline.
        writer.write("bbbbbbbbb");
        writer.write("ccccccccc");
        await writer.close();

        expect(await readFile(path, "utf8")).toBe("ccccccccc\n");
        expect(await readFile(`${path}.1`, "utf8")).toBe("bbbbbbbbb\n");
    });

    it("drops lines it cannot hold and says how many", async () => {
        const path = await temporaryFile("agent.log");
        const writer = await RotatingFileWriter.open({
            maxBytes: 1_048_576,
            maxPendingBytes: 8,
            path,
        });

        writer.write("this line is far larger than the pending budget");
        expect(writer.droppedLines).toBe(1);

        await writer.close();
        expect(await readFile(path, "utf8")).toBe("");
    });

    it("drops writes made after it closed instead of failing them", async () => {
        const path = await temporaryFile("agent.log");
        const writer = await RotatingFileWriter.open({
            maxBytes: 1_048_576,
            maxPendingBytes: 1_048_576,
            path,
        });

        writer.write("before");
        await writer.close();
        writer.write("after");
        await writer.close();

        expect(writer.droppedLines).toBe(1);
        expect(writer.failedLines).toBe(0);
        expect(await readFile(path, "utf8")).toBe("before\n");
    });

    it("refuses a budget that could not hold anything", async () => {
        const path = await temporaryFile("agent.log");

        await expect(
            RotatingFileWriter.open({ maxBytes: 0, maxPendingBytes: 1_048_576, path }),
        ).rejects.toThrow("at least one byte");
        await expect(
            RotatingFileWriter.open({ maxBytes: 1_048_576, maxPendingBytes: 0, path }),
        ).rejects.toThrow("at least one pending byte");
    });
});
