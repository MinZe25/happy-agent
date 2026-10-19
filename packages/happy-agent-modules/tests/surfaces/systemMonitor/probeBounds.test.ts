import { afterEach, describe, expect, it } from "vitest";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { HostProbes, readBounded } from "../../../sources/surfaces/systemMonitor/HostProbes.js";

const paths: string[] = [];
afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
describe("host probe resource bounds", () => {
    it("rejects oversized filesystem output instead of allocating or parsing it", async () => {
        const root = resolve(".local");
        await mkdir(root, { recursive: true });
        const path = await mkdtemp(join(root, "probe-"));
        paths.push(path);
        const file = join(path, "fixture");
        await writeFile(file, "x".repeat(100));
        await expect(readBounded(file, 100)).resolves.toBe("x".repeat(100));
        await expect(readBounded(file, 99)).rejects.toThrow("output limit");
    });
    it("kills command probes that exceed their output or time budget", async () => {
        const probes = new HostProbes(createRootContext().named("probe-test"));
        await expect(
            probes.command(process.execPath, [
                "-e",
                "process.stdout.write('x'.repeat(3 * 1024 * 1024))",
            ]),
        ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
        await expect(
            probes.command(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
        ).rejects.toMatchObject({ killed: true });
    });
    it("cancels command probes with the sampler lifetime", async () => {
        const controller = new AbortController();
        const probes = new HostProbes(
            withLifetime(createRootContext().named("probe-test"), controller.signal),
        );
        const command = probes.command(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        controller.abort();
        await expect(command).rejects.toMatchObject({ name: "AbortError" });
    });
});
