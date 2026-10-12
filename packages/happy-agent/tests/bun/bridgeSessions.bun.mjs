import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachVhciDevice } from "../../../happy-agent-modules/sources/bridges/impl/attachVhciDevice.ts";
import { PortBridgeSession } from "../../../happy-agent-modules/sources/bridges/impl/PortBridgeSession.ts";

const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ctx = { log: { warn: () => undefined, error: () => undefined, debug: () => undefined } };

/** The client's side of one bridge WebSocket, as the server would present it. */
function fakeWebSocket() {
    const socket = {
        bufferedAmount: 0,
        messages: [],
        closedWith: undefined,
        binding: undefined,
        send(data) {
            if (socket.closedWith === undefined)
                socket.messages.push(typeof data === "string" ? data : Buffer.from(data));
        },
        close(code, reason) {
            if (socket.closedWith !== undefined) return;
            socket.closedWith = { code, reason };
            queueMicrotask(() => socket.binding?.closed());
        },
    };
    return socket;
}

async function until(check) {
    const deadline = Date.now() + 3000;
    for (;;) {
        const value = check();
        if (value !== undefined && value !== false) return value;
        if (Date.now() > deadline) throw new Error("Timed out.");
        await Bun.sleep(5);
    }
}

test("Bun runs a port bridge's paused listener, owner check, and relay", async () => {
    const ended = [];
    const session = new PortBridgeSession({
        ctx,
        opened: (listener) => ({ id: "bridgefixture", port: listener }),
        ended: (ending) => ended.push(ending.reason),
    });
    const listener = await session.listen(0);
    cleanups.push(() =>
        session.end({ reason: "daemon_shutdown", code: 1001, message: "Shutting down." }),
    );
    expect(listener.host).toBe("127.0.0.1");
    const control = fakeWebSocket();
    control.binding = session.attach(control);
    expect(JSON.parse(control.messages[0])).toEqual({
        type: "ready",
        bridge: { id: "bridgefixture", port: listener },
    });

    const program = connect(listener.port, "127.0.0.1");
    cleanups.push(() => program.destroy());
    // The program may write before anyone accepts; nothing is read until the client does.
    program.write("early");
    const announced = await until(
        () => control.messages.slice(1).map((message) => JSON.parse(message))[0],
    );
    expect(announced.type).toBe("connection");

    const carrier = fakeWebSocket();
    const admission = session.accept(announced.connectionId);
    expect(session.accept(announced.connectionId)).toBeUndefined();
    carrier.binding = admission.attach(carrier);
    await until(() => carrier.messages.length > 0);
    expect(Buffer.concat(carrier.messages).toString()).toBe("early");

    const answer = new Promise((resolve) => program.once("data", (data) => resolve(String(data))));
    carrier.binding.message(Buffer.from("late"));
    expect(await answer).toBe("late");

    control.binding.closed();
    expect(carrier.closedWith?.code).toBe(1000);
    expect(ended).toEqual(["client_closed"]);
}, 5000);

test("Bun hands the attach helper one end of a socket pair as descriptor 3", async () => {
    const controller = await mkdtemp(join(tmpdir(), "happy-vhci-"));
    cleanups.push(() => rm(controller, { force: true, recursive: true }));
    await writeFile(
        join(controller, "status"),
        "hub port sta spd dev      sockfd local_busid\nhs  0000 004 000 00000000 000000 0-0\n",
    );
    await writeFile(join(controller, "attach"), "");

    const attached = await attachVhciDevice(controller, { devid: 0x00010002, speed: 3 });

    expect(await readFile(join(controller, "attach"), "utf8")).toBe(`0 3 ${0x00010002} 3`);
    // Nothing kept the helper's end, as the kernel would, so the daemon's end closes.
    await until(() => attached.socket.destroyed || undefined);
}, 5000);

test("Bun keeps the daemon's end open after the helper exits while another holder keeps its own", async () => {
    // The kernel takes its own reference to the helper's end, exactly as this background reader
    // does. The bridge relies on the daemon's end outliving the helper for as long as it does.
    const child = spawn("/bin/sh", ["-c", "(cat <&3 >/dev/null) & exit 0"], {
        stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    const socket = child.stdio[3];
    let ended = false;
    socket.on("end", () => (ended = true));
    await new Promise((resolve) => child.once("exit", resolve));
    await Bun.sleep(100);
    expect(socket.destroyed).toBe(false);
    expect(ended).toBe(false);

    // Closing the daemon's end is what detaches a device: the holder sees the end and leaves.
    socket.end();
    await until(() => socket.destroyed || undefined);
}, 5000);
