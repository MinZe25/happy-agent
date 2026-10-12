import { release } from "node:os";
import { join } from "node:path";

import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { attachVhciDevice, type AttachedUsbDevice } from "./attachVhciDevice.js";
import { probeUsbMachine, type UsbMachineProbe, type UsbMachineRoots } from "./probeUsbMachine.js";

/** The kernel's USB/IP virtual host controller on the machine the daemon runs on. */
export interface UsbHostController {
    /** What the kernel can take right now. */
    probe(): Promise<UsbMachineProbe>;
    /** Attaches one imported device, or throws a `UsbAttachError`. */
    attach(
        ctx: Context,
        device: { readonly devid: number; readonly speed: number },
    ): Promise<AttachedUsbDevice>;
}

/** The real controller, under `/sys/devices/platform/vhci_hcd.0`. */
export function createUsbHostController(
    roots: UsbMachineRoots = {
        controller: "/sys/devices/platform/vhci_hcd.0",
        loadedModules: "/sys/module",
        moduleTrees: [join("/lib/modules", release()), join("/usr/lib/modules", release())],
        platform: process.platform,
    },
): UsbHostController {
    // Two bridges choosing a port at once would choose the same one. The kernel would refuse the
    // second and it would try again, but there is no reason to race against ourselves.
    const attaching: AsyncLock = asyncLock();
    return {
        probe: async () => await probeUsbMachine(roots),
        attach: async (ctx, device) =>
            await attaching.runInLock(
                ctx,
                async () => await attachVhciDevice(roots.controller, device),
            ),
    };
}
