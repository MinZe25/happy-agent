import type { Context } from "@steve.kite/stdlib";

import {
    MobileConnectorError,
    type MobileConnectorModule,
} from "../../../sources/mobileConnector/index.js";
import type { PhoneTransport } from "./fakePhone.js";

const HANDSHAKE = "/v0/mobile-connector/handshake";

/**
 * The phone's requests delivered to the module the way the API delivers them: authenticate the
 * bearer first, then let each credential reach only its own handshake route. The gym runs the same
 * phone over the daemon's real HTTP.
 */
export function moduleTransport(mobile: MobileConnectorModule, ctx: Context): PhoneTransport {
    return async ({ method, path, credential, body }) => {
        try {
            const found = await mobile.authenticate(ctx, `Bearer ${credential}`);
            const url = new URL(path, "http://phone.invalid");
            if (found?.kind === "pairing" && method === "POST" && url.pathname === HANDSHAKE) {
                return {
                    status: 200,
                    body: await mobile.startHandshake(ctx, found.token, body),
                };
            }
            if (found?.kind === "handshake") {
                const id = found.handshakeId;
                if (method === "GET" && url.pathname === HANDSHAKE) {
                    const wait = Number(url.searchParams.get("wait") ?? "0");
                    return {
                        status: 200,
                        body: await mobile.handshakeStatus(id, wait, new AbortController().signal),
                    };
                }
                if (method === "POST" && url.pathname === `${HANDSHAKE}/reveal`) {
                    return { status: 200, body: await mobile.revealHandshake(ctx, id, body) };
                }
                if (method === "POST" && url.pathname === `${HANDSHAKE}/confirm`) {
                    return { status: 200, body: await mobile.confirmHandshake(ctx, id, body) };
                }
                if (method === "POST" && url.pathname === `${HANDSHAKE}/reject`) {
                    return { status: 200, body: await mobile.rejectHandshake(ctx, id) };
                }
            }
            return { status: 401, body: { error: "Unauthorized", code: "unauthorized" } };
        } catch (error: unknown) {
            if (!(error instanceof MobileConnectorError)) throw error;
            return { status: error.status, body: { error: error.message, code: error.code } };
        }
    };
}
