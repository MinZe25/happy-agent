import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { attachVhciDevice, UsbAttachError } from "../../sources/bridges/impl/attachVhciDevice.js";
import { parseVhciStatus, readVhciPorts } from "../../sources/bridges/impl/vhciPorts.js";

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
});

const HEADER = "hub port sta spd dev      sockfd local_busid\n";

function status(lines: readonly string[]): string {
    return HEADER + lines.map((line) => `${line}\n`).join("");
}

/** A stand-in for `/sys/devices/platform/vhci_hcd.0`, whose attach control is a plain file. */
async function controller(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-vhci-"));
    directories.push(directory);
    await writeFile(join(directory, "attach"), "");
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(directory, name), content);
    }
    return directory;
}

describe("virtual host controller ports", () => {
    it("reads which ports are free on each hub", () => {
        expect(
            parseVhciStatus(
                status([
                    "hs  0000 006 002 00010004 000003 1-1",
                    "hs  0001 004 000 00000000 000000 0-0",
                    "ss  0008 004 000 00000000 000000 0-0",
                ]),
            ),
        ).toEqual([
            { hub: "hs", port: 0, free: false },
            { hub: "hs", port: 1, free: true },
            { hub: "ss", port: 8, free: true },
        ]);
    });

    it("reads every controller's status file", async () => {
        const path = await controller({
            status: status(["hs  0000 004 000 00000000 000000 0-0"]),
            "status.1": status(["hs  0016 004 000 00000000 000000 0-0"]),
            nports: "32\n",
        });

        const ports = await readVhciPorts(path);

        expect(ports.map((port) => port.port).sort((a, b) => a - b)).toEqual([0, 16]);
    });
});

describe("attaching a device to the kernel", () => {
    it("writes `port 3 devid speed` from a helper holding the socket as descriptor 3", async () => {
        const path = await controller({
            status: status([
                "hs  0000 006 002 00010004 000003 1-1",
                "hs  0001 004 000 00000000 000000 0-0",
            ]),
        });

        const attached = await attachVhciDevice(path, { devid: 0x00030007, speed: 2 });

        expect(attached.port).toBe(1);
        expect(await readFile(join(path, "attach"), "utf8")).toBe(`1 3 ${String(0x00030007)} 2`);
        // Nothing here keeps the helper's end the way the kernel would, so the daemon's end sees
        // the connection close as soon as the helper exits: exactly what a detached device looks
        // like.
        await new Promise<void>((resolve) => {
            if (attached.socket.destroyed) resolve();
            attached.socket.once("close", () => resolve());
            attached.socket.resume();
        });
    });

    it("puts a SuperSpeed device on a SuperSpeed port, and a faster one at SuperSpeed", async () => {
        const path = await controller({
            status: status([
                "hs  0000 004 000 00000000 000000 0-0",
                "ss  0008 004 000 00000000 000000 0-0",
            ]),
        });

        const attached = await attachVhciDevice(path, { devid: 0x00020003, speed: 6 });
        attached.socket.destroy();

        expect(attached.port).toBe(8);
        expect(await readFile(join(path, "attach"), "utf8")).toBe(`8 3 ${String(0x00020003)} 5`);
    });

    it("reports when no port of the device's speed is free", async () => {
        const path = await controller({
            status: status([
                "hs  0000 006 002 00010004 000003 1-1",
                "ss  0008 004 000 00000000 000000 0-0",
            ]),
        });

        await expect(attachVhciDevice(path, { devid: 1, speed: 3 })).rejects.toMatchObject({
            name: "UsbAttachError",
            reason: "no_free_port",
        });
    });

    it("reports a refusal when the port is still free after the kernel turned it down", async () => {
        const path = await controller({
            status: status(["hs  0000 004 000 00000000 000000 0-0"]),
        });
        // A directory cannot be written, as a kernel that refuses the attachment cannot be.
        await rm(join(path, "attach"));
        await mkdir(join(path, "attach"));

        const failure = await attachVhciDevice(path, { devid: 1, speed: 2 }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(UsbAttachError);
        expect(failure).toMatchObject({ reason: "refused" });
    });
});
