import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import type { MobileCredential } from "../../mobileConnector/index.js";

export type ApiMobileDevice = Extract<MobileCredential, { readonly kind: "device" }>;

// Neither survives `detach`: work that outlives a phone's request is not on its socket.
const mobileTransportNamespace = createContextNamespace<boolean>(
    "happyAgent.apiMobileTransport",
    false,
    { detachable: false },
);

const mobileDeviceNamespace = createContextNamespace<ApiMobileDevice | undefined>(
    "happyAgent.apiMobileDevice",
    undefined,
    { detachable: false },
);

/**
 * Mark a request, upgrade, or `CONNECT` as arriving on the mobile connector's socket. The API then
 * accepts only mobile credentials for it, before anything else.
 */
export function withMobileTransport(ctx: Context): Context {
    return mobileTransportNamespace.set(ctx, true);
}

export function isMobileTransport(ctx: Context): boolean {
    return mobileTransportNamespace.get(ctx);
}

/** The paired phone this mobile-transport work authenticated as. */
export function withMobileDevice(ctx: Context, device: ApiMobileDevice): Context {
    return mobileDeviceNamespace.set(ctx, device);
}

export function mobileDevice(ctx: Context): ApiMobileDevice | undefined {
    return mobileDeviceNamespace.get(ctx);
}
