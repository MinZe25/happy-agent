import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { DockerConnection } from "../../../sources/docker/impl/DockerConnection.js";
import { READY, frame, header, stdcopy } from "./connectFrames.js";

describe("DockerConnection", () => {
    it("opens on READY even when Docker splits every header and frame", async () => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);
        const bytes = Buffer.concat([
            stdcopy(1, frame("R", READY)),
            stdcopy(1, frame("D", Buffer.from("hello"))),
            stdcopy(1, frame("D", Buffer.from(" world"))),
        ]);

        for (const byte of bytes) attach.deliver(Buffer.of(byte));

        await expect(connection.open()).resolves.toBe(connection);
        expect(readBuffered(connection)).toBe("hello world");
    });

    it("writes bounded data frames and half-closes without closing the transport", async () => {
        const { attach, connection } = await opened();
        const body = Buffer.alloc(150 * 1024, 7);

        await write(connection, body);
        await new Promise<void>((resolve) => connection.end(resolve));

        const frames = parseFrames(Buffer.concat(attach.written));
        expect(frames.map(({ type, payload }) => [type, payload.byteLength])).toEqual([
            ["D", 65_536],
            ["D", 65_536],
            ["D", 22_528],
            ["F", 0],
        ]);
        expect(Buffer.concat(frames.map(({ payload }) => payload))).toEqual(body);
        expect(attach.destroyed).toBe(false);

        attach.deliver(stdcopy(1, frame("D", Buffer.from("reply"))));
        expect(readBuffered(connection)).toBe("reply");
    });

    it("ends its readable side on the remote half-close and keeps writing", async () => {
        const { attach, connection } = await opened();
        const ended = new Promise<void>((resolve) => connection.once("end", resolve));
        connection.resume();

        attach.deliver(stdcopy(1, frame("F", Buffer.alloc(0))));
        await ended;
        await write(connection, Buffer.from("still sending"));

        expect(parseFrames(Buffer.concat(attach.written))).toEqual([
            { type: "D", payload: Buffer.from("still sending") },
        ]);
        expect(connection.destroyed).toBe(false);
    });

    it("closes cleanly once both sides half-closed and the helper exited", async () => {
        const { attach, connection } = await opened();
        connection.resume();
        const closed = new Promise<Error | undefined>((resolve) => {
            connection.once("error", resolve);
            connection.once("close", () => resolve(undefined));
        });

        connection.end();
        attach.deliver(stdcopy(1, frame("F", Buffer.alloc(0))));
        attach.finish();

        await expect(closed).resolves.toBeUndefined();
    });

    it("lets the helper finish delivering after a clean finish, and can still abort it", async () => {
        const { attach, connection } = await opened();
        connection.resume();
        const closed = new Promise<void>((resolve) => connection.once("close", resolve));

        connection.end("last bytes");
        attach.deliver(stdcopy(1, frame("F", Buffer.alloc(0))));
        await closed;

        expect(attach.destroyed).toBe(false);
        connection.abort();
        expect(attach.destroyed).toBe(true);
    });

    it("closes the transport at once when destroyed before both sides finished", async () => {
        const { attach, connection } = await opened();
        connection.end("half");

        connection.destroy();

        expect(attach.destroyed).toBe(true);
    });

    it("reports a failure before READY with the helper's error code", async () => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);

        attach.deliver(stdcopy(1, frame("X", Buffer.from("ECONNREFUSED Connection refused"))));

        await expect(connection.open()).rejects.toMatchObject({
            code: "ECONNREFUSED",
            message: "The connection inside the container failed: Connection refused",
        });
        expect(attach.destroyed).toBe(true);
    });

    it("refuses a supervisor that predates connections", async () => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);

        attach.deliver(
            stdcopy(
                2,
                Buffer.from(
                    "happy-agent-supervisor: unknown supervisor argument before --: --connect\n",
                ),
            ),
        );
        attach.finish();

        await expect(connection.open()).rejects.toMatchObject({ code: "ENOTSUP" });
    });

    it("refuses a READY from another connection protocol", async () => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);

        attach.deliver(stdcopy(1, frame("R", Buffer.from("happy-agent-connect/2"))));

        await expect(connection.open()).rejects.toMatchObject({ code: "ENOTSUP" });
    });

    it.each([
        ["data before READY", [frame("D", Buffer.from("early"))], false],
        ["an oversized frame", [header("D", 65_537)], true],
        ["an empty data frame", [frame("D", Buffer.alloc(0))], true],
        ["data after the remote half-close", [frame("F"), frame("D", Buffer.from("late"))], true],
        ["an unknown frame", [frame("Q")], true],
    ])("drops the connection on %s", async (_name, frames, afterReady) => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);
        const failure = new Promise<Error>((resolve) => connection.once("error", resolve));
        if (afterReady) {
            attach.deliver(stdcopy(1, frame("R", READY)));
            await connection.open();
            connection.resume();
        }

        for (const bytes of frames) attach.deliver(stdcopy(1, bytes));

        if (afterReady) await expect(failure).resolves.toMatchObject({ code: "EPROTO" });
        else await expect(connection.open()).rejects.toMatchObject({ code: "EPROTO" });
        expect(attach.destroyed).toBe(true);
    });

    it("drops the connection on output from an unknown Docker stream", async () => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);

        attach.deliver(stdcopy(0, frame("R", READY)));

        await expect(connection.open()).rejects.toMatchObject({ code: "EPROTO" });
    });

    it("fails when the helper stops before either side finished", async () => {
        const { attach, connection } = await opened();
        const failure = new Promise<Error>((resolve) => connection.once("error", resolve));

        attach.finish();

        await expect(failure).resolves.toMatchObject({ code: "ECONNRESET" });
    });

    it("closes the transport, which aborts the helper, when destroyed before READY", async () => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);

        connection.destroy();

        await expect(connection.open()).rejects.toMatchObject({ code: "ECONNABORTED" });
        expect(attach.destroyed).toBe(true);
    });

    it("refuses to hand over a connection closed between READY and the hand-over", async () => {
        const attach = new ScriptedAttach();
        const connection = new DockerConnection(attach);

        attach.deliver(stdcopy(1, frame("R", READY)));
        connection.destroy();

        await expect(connection.open()).rejects.toMatchObject({ code: "ECONNABORTED" });
        expect(attach.destroyed).toBe(true);
    });

    it("pauses the transport while its reader is behind", async () => {
        const { attach, connection } = await opened();
        const chunk = Buffer.alloc(64 * 1024, 1);

        attach.deliver(stdcopy(1, frame("D", chunk)));
        expect(attach.isPaused()).toBe(true);

        connection.read();
        await new Promise((resolve) => setImmediate(resolve));
        expect(attach.isPaused()).toBe(false);
    });
});

/** The attach end of a `docker exec`, driven by the test. */
class ScriptedAttach extends Duplex {
    readonly written: Buffer[] = [];

    deliver(bytes: Buffer): void {
        this.emit("data", bytes);
    }

    finish(): void {
        this.emit("end");
        this.emit("close");
    }

    override _read(): void {}

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        this.written.push(chunk);
        callback();
    }
}

async function opened(): Promise<{ attach: ScriptedAttach; connection: DockerConnection }> {
    const attach = new ScriptedAttach();
    const connection = new DockerConnection(attach);
    attach.deliver(stdcopy(1, frame("R", READY)));
    await connection.open();
    return { attach, connection };
}

function parseFrames(bytes: Buffer): Array<{ type: string; payload: Buffer }> {
    const frames: Array<{ type: string; payload: Buffer }> = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
        const length = bytes.readUInt32BE(offset + 1);
        frames.push({
            type: String.fromCharCode(bytes[offset]!),
            payload: bytes.subarray(offset + 5, offset + 5 + length),
        });
        offset += 5 + length;
    }
    return frames;
}

/** Everything buffered so far. Bun's `read()` returns one chunk at a time; Node's returns all. */
function readBuffered(connection: DockerConnection): string {
    const chunks: Buffer[] = [];
    for (
        let chunk = connection.read() as Buffer | null;
        chunk !== null;
        chunk = connection.read()
    ) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
}

function write(connection: DockerConnection, bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) =>
        connection.write(bytes, (error) => (error ? reject(error) : resolve())),
    );
}
