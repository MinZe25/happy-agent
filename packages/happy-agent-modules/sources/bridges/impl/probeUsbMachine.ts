import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceBridgeReason } from "@slopus/happy-agent-client";

/** What this machine's kernel can take over a USB bridge. `null` means available. */
export interface UsbMachineProbe {
    readonly usb: WorkspaceBridgeReason | null;
    readonly bluetooth: WorkspaceBridgeReason | null;
}

/** Where a kernel's controls and module files are, so a test can stand in a fake one. */
export interface UsbMachineRoots {
    /** The virtual host controller's platform device directory. */
    readonly controller: string;
    /** `/sys/module`, where loaded modules appear. */
    readonly loadedModules: string;
    /** The running kernel's module directories, `/lib/modules/<release>` and its `/usr` twin. */
    readonly moduleTrees: readonly string[];
    readonly platform: NodeJS.Platform;
}

/** Reads the kernel's own controls and module files; it runs nothing and loads nothing. */
export async function probeUsbMachine(roots: UsbMachineRoots): Promise<UsbMachineProbe> {
    if (roots.platform !== "linux") {
        const reason = {
            code: "unsupported_platform",
            message: "USB devices can be attached only to a workspace on a Linux machine.",
        };
        return { usb: reason, bluetooth: reason };
    }
    const usb = await probeVhci(roots);
    if (usb !== null) return { usb, bluetooth: usb };
    const bluetooth =
        (await exists(join(roots.loadedModules, "btusb"))) ||
        (await kernelHasModule(roots.moduleTrees, "kernel/drivers/bluetooth/", "btusb.ko"))
            ? null
            : {
                  code: "bluetooth_driver_missing",
                  message: "The workspace's machine has no USB Bluetooth driver (btusb).",
              };
    return { usb, bluetooth };
}

async function probeVhci(roots: UsbMachineRoots): Promise<WorkspaceBridgeReason | null> {
    const attach = join(roots.controller, "attach");
    if (!(await exists(attach))) {
        return (await kernelHasModule(
            roots.moduleTrees,
            "kernel/drivers/usb/usbip/",
            "vhci-hcd.ko",
        ))
            ? {
                  code: "vhci_not_loaded",
                  message:
                      "The workspace's machine supports USB/IP, but the vhci-hcd kernel module is not loaded. Load it with: sudo modprobe vhci-hcd",
              }
            : {
                  code: "vhci_missing",
                  message:
                      "The workspace's machine has no USB/IP virtual host controller (vhci-hcd) in its kernel.",
              };
    }
    try {
        await access(attach, constants.W_OK);
        return null;
    } catch {
        return {
            code: "permission_denied",
            message: `Happy Agent's user cannot attach USB devices on the workspace's machine. Run Happy Agent as root, or grant its user write access to ${attach} with a udev rule.`,
        };
    }
}

/** Whether the running kernel ships a module, as a file under its tree or built in. */
async function kernelHasModule(
    trees: readonly string[],
    directory: string,
    file: string,
): Promise<boolean> {
    for (const tree of trees) {
        try {
            // Distributions compress module files as `.ko.xz`, `.ko.zst`, or `.ko.gz`.
            const names = await readdir(join(tree, directory));
            if (names.some((name) => name === file || name.startsWith(`${file}.`))) return true;
        } catch {
            // The directory is absent; the module may still be listed below.
        }
        for (const index of ["modules.builtin", "modules.dep"]) {
            try {
                const listing = await readFile(join(tree, index), "utf8");
                if (new RegExp(`(^|/)${escape(file)}(\\.\\w+)?(:|$)`, "m").test(listing))
                    return true;
            } catch {
                // An absent index says nothing either way.
            }
        }
    }
    return false;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
