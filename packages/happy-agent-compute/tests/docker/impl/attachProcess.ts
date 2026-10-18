import { spawn, type ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";

/**
 * Docker's non-TTY `exec` attach, emulated over a local process.
 *
 * What is written reaches the program's standard input. Its standard output and error come back
 * multiplexed behind Docker's eight-byte headers, from two pipes read independently, so their
 * relative order is not preserved — exactly as Docker does not preserve it. Ending the attach
 * closes standard input, and so does destroying it, as Docker does when a client closes its
 * hijacked connection. The attach ends only once the program has exited and its output is
 * delivered. A reader that falls behind stops the program's output being read.
 */
export function attachProcess(
    command: string,
    args: readonly string[],
): { attach: Duplex; child: ChildProcess; exited: Promise<number | null> } {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => {
        child.once("close", (code) => resolve(code));
    });
    const attach = new ProcessAttach(child);
    return { attach, child, exited };
}

class ProcessAttach extends Duplex {
    readonly #child: ChildProcess;

    constructor(child: ChildProcess) {
        super({ allowHalfOpen: true });
        this.#child = child;
        // The program may exit with input still unread; that is not the attach's failure.
        child.stdin!.on("error", () => undefined);
        const forward = (stream: 1 | 2) => (chunk: Buffer) => {
            const header = Buffer.alloc(8);
            header[0] = stream;
            header.writeUInt32BE(chunk.byteLength, 4);
            if (!this.push(Buffer.concat([header, chunk]))) {
                child.stdout!.pause();
                child.stderr!.pause();
            }
        };
        child.stdout!.on("data", forward(1));
        child.stderr!.on("data", forward(2));
        child.once("close", () => this.push(null));
    }

    override _read(): void {
        this.#child.stdout!.resume();
        this.#child.stderr!.resume();
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        const input = this.#child.stdin!;
        if (input.destroyed || input.writableEnded) {
            callback();
            return;
        }
        input.write(chunk, () => callback());
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.#child.stdin!.end();
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.#child.stdin!.destroy();
        callback(error);
    }
}
