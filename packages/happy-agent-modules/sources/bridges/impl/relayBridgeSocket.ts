import type { Duplex } from "node:stream";

import { WORKSPACE_BRIDGE_MAX_BINARY_MESSAGE_BYTES } from "@slopus/happy-agent-client";

import type { BridgeWebSocket } from "../Bridge.js";

/** Above this many unsent bytes, the socket stops being read until the client catches up. */
const WEBSOCKET_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const WEBSOCKET_LOW_WATER_BYTES = 1024 * 1024;
/** Above this many bytes the socket has not taken, its reader is not keeping up at all. */
const SOCKET_MAX_PENDING_BYTES = 16 * 1024 * 1024;
const SOCKET_HIGH_WATER_BYTES = 1024 * 1024;

export interface BridgeRelay {
    /** Bytes from the client, for the socket. */
    write(data: Uint8Array): void;
    /** Stops relaying. The caller closes the socket and the WebSocket itself. */
    stop(): void;
}

/**
 * Moves bytes between one socket and one bridge WebSocket until the socket ends.
 *
 * Each side is held back while the other is behind: the socket stops being read while the
 * WebSocket has too much unsent, and the WebSocket stops being read, where its server allows it,
 * while the socket has too much unwritten. A server that cannot pause its reads leaves the second
 * bound to `SOCKET_MAX_PENDING_BYTES`, past which the relay gives up with `"overflow"`.
 */
export function relayBridgeSocket(
    socket: Duplex,
    webSocket: BridgeWebSocket,
    ended: (cause: "socket" | "overflow") => void,
): BridgeRelay {
    let stopped = false;
    let draining: ReturnType<typeof setTimeout> | undefined;
    let webSocketPaused = false;

    const waitForClient = (): void => {
        draining = setTimeout(() => {
            draining = undefined;
            if (stopped) return;
            if (webSocket.bufferedAmount <= WEBSOCKET_LOW_WATER_BYTES) socket.resume();
            else waitForClient();
        }, 10);
        draining.unref?.();
    };
    const data = (chunk: Buffer): void => {
        for (
            let offset = 0;
            offset < chunk.length;
            offset += WORKSPACE_BRIDGE_MAX_BINARY_MESSAGE_BYTES
        ) {
            webSocket.send(
                chunk.subarray(offset, offset + WORKSPACE_BRIDGE_MAX_BINARY_MESSAGE_BYTES),
            );
        }
        if (draining === undefined && webSocket.bufferedAmount > WEBSOCKET_HIGH_WATER_BYTES) {
            socket.pause();
            waitForClient();
        }
    };
    const drained = (): void => {
        if (!webSocketPaused) return;
        webSocketPaused = false;
        webSocket.resume?.();
    };
    const finish = (): void => {
        if (stopped) return;
        stop();
        ended("socket");
    };
    const stop = (): void => {
        stopped = true;
        if (draining !== undefined) clearTimeout(draining);
        draining = undefined;
        socket.off("data", data);
        socket.off("drain", drained);
        socket.off("end", finish);
        socket.off("close", finish);
        socket.off("error", finish);
    };

    // An error after the relay has stopped must not become an unhandled one.
    socket.on("error", () => undefined);
    socket.on("data", data);
    socket.on("drain", drained);
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", finish);
    socket.resume();
    // A socket that closed before the relay began will not say so again.
    if (socket.destroyed) queueMicrotask(finish);

    return {
        write(bytes) {
            if (stopped) return;
            socket.write(bytes);
            if (socket.writableLength > SOCKET_MAX_PENDING_BYTES) {
                stop();
                ended("overflow");
                return;
            }
            if (
                !webSocketPaused &&
                webSocket.pause !== undefined &&
                socket.writableLength > SOCKET_HIGH_WATER_BYTES
            ) {
                webSocketPaused = true;
                webSocket.pause();
            }
        },
        stop,
    };
}
