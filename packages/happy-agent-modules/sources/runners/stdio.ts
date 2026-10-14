import { MAX_RUNNER_FRAME_BYTES, type RunnerChannel } from "@slopus/happy-agent-compute";
import type { Readable, Writable } from "node:stream";

/** The length prefix in front of every frame on a byte stream. */
const PREFIX_BYTES = 4;

/**
 * A runner connection over a pair of byte streams, such as a child process's standard input and
 * output: each frame is sent as its 32-bit big-endian length followed by the frame.
 *
 * The daemon speaks it to a runner it started itself, and that runner speaks it on its own
 * standard input and output. Whoever holds the other end of the pipe started the process, so the
 * pipe is the authentication. A length past the largest frame, or a stream that ends partway
 * through one, ends the channel as a protocol violation.
 */
export function stdioRunnerChannel(input: Readable, output: Writable): RunnerChannel {
    let closed = false;
    let receiver: Parameters<RunnerChannel["receive"]>[0] | undefined;
    let pendingReason: string | undefined;
    const chunks: Buffer[] = [];
    let buffered = 0;

    const detach = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("close", onEnd);
        input.off("error", onInputError);
        output.off("error", onOutputError);
    };
    const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        detach();
        // A late error from either stream after the channel closed must not crash the process.
        input.on("error", ignore);
        output.on("error", ignore);
        chunks.length = 0;
        buffered = 0;
        if (receiver === undefined) pendingReason = reason;
        else receiver.close(reason);
    };
    const end = (reason: string) => {
        if (!closed) output.end();
        input.destroy();
        finish(reason);
    };

    /** Take `count` buffered bytes off the front, joining chunks only when a frame spans them. */
    const take = (count: number): Buffer => {
        const first = chunks[0] as Buffer;
        if (first.length === count) {
            chunks.shift();
            buffered -= count;
            return first;
        }
        if (first.length > count) {
            chunks[0] = first.subarray(count);
            buffered -= count;
            return first.subarray(0, count);
        }
        const joined = Buffer.allocUnsafe(count);
        let offset = 0;
        while (offset < count) {
            const chunk = chunks[0] as Buffer;
            const used = Math.min(chunk.length, count - offset);
            chunk.copy(joined, offset, 0, used);
            offset += used;
            if (used === chunk.length) chunks.shift();
            else chunks[0] = chunk.subarray(used);
        }
        buffered -= count;
        return joined;
    };
    let expected: number | undefined;
    const onData = (chunk: Buffer) => {
        if (closed) return;
        chunks.push(chunk);
        buffered += chunk.length;
        while (!closed) {
            if (expected === undefined) {
                if (buffered < PREFIX_BYTES) return;
                expected = take(PREFIX_BYTES).readUInt32BE(0);
                if (expected > MAX_RUNNER_FRAME_BYTES) {
                    end(
                        `The other side sent a frame of ${String(expected)} bytes, larger than the runner protocol allows.`,
                    );
                    return;
                }
            }
            if (buffered < expected) return;
            const frame = take(expected);
            expected = undefined;
            receiver?.frame(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
        }
    };
    const onEnd = () => {
        finish(
            expected !== undefined || buffered > 0
                ? "The connection ended partway through a frame."
                : "The other side closed the connection.",
        );
    };
    const onInputError = (error: Error) =>
        end(`The connection could not be read: ${error.message}`);
    const onOutputError = (error: Error) =>
        end(`The connection could not be written to: ${error.message}`);

    input.pause();
    input.on("error", onInputError);
    output.on("error", onOutputError);
    return {
        send(frame) {
            if (closed) return;
            if (frame.byteLength > MAX_RUNNER_FRAME_BYTES) {
                end("A frame larger than the runner protocol allows was not sent.");
                return;
            }
            const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
            prefix.writeUInt32BE(frame.byteLength, 0);
            output.write(prefix);
            output.write(frame);
        },
        close(reason) {
            end(reason);
        },
        receive(next) {
            if (receiver !== undefined) throw new Error("A runner channel has one receiver.");
            receiver = next;
            if (pendingReason !== undefined) {
                next.close(pendingReason);
                return;
            }
            input.on("data", onData);
            input.on("end", onEnd);
            input.on("close", onEnd);
            input.resume();
        },
    };
}

function ignore(): void {}
