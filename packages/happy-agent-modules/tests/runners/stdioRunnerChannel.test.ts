import { PassThrough } from "node:stream";

import { MAX_RUNNER_FRAME_BYTES, type RunnerChannel } from "@slopus/happy-agent-compute";
import { describe, expect, it } from "vitest";

import { stdioRunnerChannel } from "../../sources/runners/stdio.js";

/** Both ends of a pipe pair, as a daemon and the runner it started see them. */
function pipePair(): {
    readonly daemon: RunnerChannel;
    readonly runner: RunnerChannel;
    readonly toRunner: PassThrough;
    readonly toDaemon: PassThrough;
} {
    const toRunner = new PassThrough();
    const toDaemon = new PassThrough();
    return {
        daemon: stdioRunnerChannel(toDaemon, toRunner),
        runner: stdioRunnerChannel(toRunner, toDaemon),
        toRunner,
        toDaemon,
    };
}

function collect(channel: RunnerChannel): { frames: Uint8Array[]; closed: Promise<string> } {
    const frames: Uint8Array[] = [];
    const closed = new Promise<string>((resolve) => {
        channel.receive({ frame: (frame) => frames.push(Buffer.from(frame)), close: resolve });
    });
    return { frames, closed };
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

describe("the runner channel over a pair of byte streams", () => {
    it("delivers whole frames in order, however the bytes are split", async () => {
        const toRunner = new PassThrough();
        const runner = collect(stdioRunnerChannel(toRunner, new PassThrough()));
        const frames = [Buffer.from("hello"), Buffer.alloc(0), Buffer.alloc(200_000, 7)];
        const wire = Buffer.concat(
            frames.flatMap((frame) => {
                const prefix = Buffer.alloc(4);
                prefix.writeUInt32BE(frame.length, 0);
                return [prefix, frame];
            }),
        );
        // One byte at a time across the prefix and the first frame, then the rest in odd pieces.
        for (let offset = 0; offset < 12; offset += 1)
            toRunner.write(wire.subarray(offset, offset + 1));
        for (let offset = 12; offset < wire.length; offset += 4_099) {
            toRunner.write(wire.subarray(offset, Math.min(wire.length, offset + 4_099)));
        }
        await settle();

        expect(runner.frames.map((frame) => Buffer.from(frame))).toEqual(frames);
    });

    it("carries frames both ways and closes the other side", async () => {
        const { daemon, runner } = pipePair();
        const atRunner = collect(runner);
        const atDaemon = collect(daemon);
        daemon.send(new TextEncoder().encode("welcome"));
        runner.send(new TextEncoder().encode("ready"));
        await settle();
        expect(Buffer.from(atRunner.frames[0] as Uint8Array).toString()).toBe("welcome");
        expect(Buffer.from(atDaemon.frames[0] as Uint8Array).toString()).toBe("ready");

        daemon.close("The daemon is shutting down.");
        await expect(atDaemon.closed).resolves.toBe("The daemon is shutting down.");
        await expect(atRunner.closed).resolves.toBe("The other side closed the connection.");
        // Sending on a closed channel is dropped, not thrown.
        expect(() => daemon.send(new Uint8Array(1))).not.toThrow();
    });

    it("ends the connection on a frame larger than the protocol allows", async () => {
        const toRunner = new PassThrough();
        const runner = collect(stdioRunnerChannel(toRunner, new PassThrough()));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(MAX_RUNNER_FRAME_BYTES + 1, 0);
        toRunner.write(prefix);

        await expect(runner.closed).resolves.toContain("larger than the runner protocol allows");
        expect(runner.frames).toHaveLength(0);
    });

    it("says so when the stream ends partway through a frame", async () => {
        const toRunner = new PassThrough();
        const runner = collect(stdioRunnerChannel(toRunner, new PassThrough()));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(10, 0);
        toRunner.end(Buffer.concat([prefix, Buffer.from("short")]));

        await expect(runner.closed).resolves.toBe("The connection ended partway through a frame.");
        expect(runner.frames).toHaveLength(0);
    });

    it("reports a close that came before anyone was listening", async () => {
        const toRunner = new PassThrough();
        const channel = stdioRunnerChannel(toRunner, new PassThrough());
        channel.close("Gone before it started.");
        const runner = collect(channel);

        await expect(runner.closed).resolves.toBe("Gone before it started.");
    });
});
