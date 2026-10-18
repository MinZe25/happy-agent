import { createServer, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { createHostNetwork } from "../../sources/host/createHostNetwork.js";

const ctx: Context = createRootContext().named("host-network-test");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("connections from the host", () => {
    it("keeps sending after the remote end finishes", async () => {
        const received = deferred<string>();
        const port = await listen((socket) => {
            socket.end("greeting");
            void readAll(socket).then(received.resolve, received.reject);
        });

        const socket = await createHostNetwork().connect(ctx, { host: "127.0.0.1", port });
        await expect(readAll(socket)).resolves.toBe("greeting");
        // Without a half-open socket the end above would already have closed this side too.
        await new Promise((resolve) => setTimeout(resolve, 20));
        socket.end("still sending");

        await expect(received.promise).resolves.toBe("still sending");
    });

    it("delivers the whole reply after the caller finishes sending", async () => {
        const port = await listen(async (socket) => {
            const request = await readAll(socket);
            socket.end(request.toUpperCase());
        });

        const socket = await createHostNetwork().connect(ctx, { host: "127.0.0.1", port });
        const reply = readAll(socket);
        socket.end("request");

        await expect(reply).resolves.toBe("REQUEST");
    });
});

async function listen(onConnection: (socket: Socket) => void | Promise<void>): Promise<number> {
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        void onConnection(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
        () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            }),
    );
    return (server.address() as AddressInfo).port;
}

function readAll(socket: Duplex): Promise<string> {
    return new Promise((resolve, reject) => {
        let text = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
            text += chunk;
        });
        socket.once("end", () => resolve(text));
        socket.once("error", reject);
    });
}

/** A promise settled from outside, as `Promise.withResolvers` does on ES2024. */
function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
