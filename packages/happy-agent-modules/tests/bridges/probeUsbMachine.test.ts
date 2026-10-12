import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    probeUsbMachine,
    type UsbMachineRoots,
} from "../../sources/bridges/impl/probeUsbMachine.js";

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await chmod(join(directory, "controller", "attach"), 0o600).catch(() => undefined);
        await rm(directory, { force: true, recursive: true });
    }
});

/** A fake kernel: an optional attach control, loaded modules, and one module tree. */
async function machine(options: {
    readonly attach?: "writable" | "readonly";
    readonly loaded?: readonly string[];
    readonly files?: readonly string[];
    readonly builtin?: readonly string[];
}): Promise<UsbMachineRoots> {
    const root = await mkdtemp(join(tmpdir(), "happy-usb-probe-"));
    directories.push(root);
    const controller = join(root, "controller");
    const loadedModules = join(root, "sys-module");
    const tree = join(root, "lib-modules");
    await mkdir(controller, { recursive: true });
    await mkdir(loadedModules, { recursive: true });
    await mkdir(tree, { recursive: true });
    if (options.attach !== undefined) {
        await writeFile(join(controller, "attach"), "");
        if (options.attach === "readonly") await chmod(join(controller, "attach"), 0o400);
    }
    for (const name of options.loaded ?? []) await mkdir(join(loadedModules, name));
    for (const file of options.files ?? []) {
        await mkdir(join(tree, file, ".."), { recursive: true });
        await writeFile(join(tree, file), "");
    }
    await writeFile(join(tree, "modules.builtin"), (options.builtin ?? []).join("\n"));
    return { controller, loadedModules, moduleTrees: [tree], platform: "linux" };
}

describe("probing what the machine can take over USB", () => {
    it("is unavailable everywhere but Linux", async () => {
        const roots = await machine({ attach: "writable" });

        const probe = await probeUsbMachine({ ...roots, platform: "darwin" });

        expect(probe.usb?.code).toBe("unsupported_platform");
        expect(probe.bluetooth?.code).toBe("unsupported_platform");
    });

    it("tells a kernel with USB/IP that is not loaded from one without it", async () => {
        const shipped = await machine({
            files: ["kernel/drivers/usb/usbip/vhci-hcd.ko.zst"],
        });
        const missing = await machine({});

        expect((await probeUsbMachine(shipped)).usb?.code).toBe("vhci_not_loaded");
        expect((await probeUsbMachine(missing)).usb?.code).toBe("vhci_missing");
    });

    it("needs write access to the attach control", async () => {
        if (process.getuid?.() === 0) return; // Root writes regardless of the file's mode.
        const roots = await machine({ attach: "readonly", loaded: ["btusb"] });

        const probe = await probeUsbMachine(roots);

        expect(probe.usb).toMatchObject({ code: "permission_denied" });
        expect(probe.usb?.message).toContain(join(roots.controller, "attach"));
        expect(probe.bluetooth).toEqual(probe.usb);
    });

    it("offers Bluetooth only with a USB Bluetooth driver, loaded or shipped", async () => {
        const loaded = await machine({ attach: "writable", loaded: ["btusb"] });
        const builtIn = await machine({
            attach: "writable",
            builtin: ["kernel/drivers/bluetooth/btusb.ko"],
        });
        const without = await machine({ attach: "writable" });

        expect(await probeUsbMachine(loaded)).toEqual({ usb: null, bluetooth: null });
        expect(await probeUsbMachine(builtIn)).toEqual({ usb: null, bluetooth: null });
        expect(await probeUsbMachine(without)).toEqual({
            usb: null,
            bluetooth: expect.objectContaining({ code: "bluetooth_driver_missing" }),
        });
    });
});
