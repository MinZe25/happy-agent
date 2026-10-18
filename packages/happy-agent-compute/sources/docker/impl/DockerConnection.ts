import { Duplex } from "node:stream";

/** The largest payload one supervisor connect frame carries in either direction. */
const MAX_FRAME_PAYLOAD = 64 * 1024;
/** What the supervisor's `--connect` mode sends first, once its TCP connection is established. */
const READY_PAYLOAD = "happy-agent-connect/1";
/** How much of the helper's standard error is kept to explain a failure. */
const MAX_DIAGNOSTIC_BYTES = 4096;
/**
 * How long a connection that finished in both directions may keep delivering what it had already
 * sent before its helper is stopped, as TCP lingers after a close.
 */
const LINGER_MS = 30_000;
/** Docker's multiplexed attach header: stream type, three padding bytes, a big-endian length. */
const STDCOPY_HEADER_BYTES = 8;
const FRAME_HEADER_BYTES = 5;

const FRAME_READY = 0x52; // R
const FRAME_DATA = 0x44; // D
const FRAME_FIN = 0x46; // F
const FRAME_ERROR = 0x58; // X

type ConnectionState = "connecting" | "open" | "closed";

/**
 * One TCP connection made from inside a container by the supervisor's `--connect` mode, as an
 * ordinary half-open Node duplex.
 *
 * The helper runs under `docker exec` with its standard streams attached to `attach`, Docker's
 * multiplexed, non-TTY stream. Bytes travel as frames in both directions, so ending this duplex's
 * writable side sends the helper a half-close while replies keep arriving, and the remote end's
 * half-close arrives as this duplex's `end` while writes keep going. Destroying it closes the
 * attach stream, which the helper treats as an abort and exits on at once — whether it is still
 * resolving the name or the remote end is ignoring the half-close.
 *
 * A slow reader pauses the attach stream, which stops Docker reading the helper's output, which
 * stops the helper reading the socket: backpressure reaches the remote end without buffering.
 *
 * Finishing cleanly is not an abort. Once both sides have half-closed, this duplex is done while
 * the helper may still be writing the caller's last bytes to the socket, so the attach stays open
 * until the helper exits by itself, within a bound.
 *
 * Until {@link open} hands the connection over, it holds its own errors: nobody else can be
 * listening yet, and a remote end that resets at once delivers READY and the failure together.
 */
export class DockerConnection extends Duplex {
    readonly #ready: Promise<void>;
    readonly #attach: Duplex;
    #state: ConnectionState = "connecting";
    #failure: Error | null = null;
    #resolveReady!: () => void;
    #rejectReady!: (error: Error) => void;
    #stdcopyHeader = Buffer.alloc(0);
    #stdcopyStream = 0;
    #stdcopyRemaining = 0;
    #frameHeader = Buffer.alloc(0);
    #frameType = 0;
    #frameRemaining = 0;
    #frameBody: Buffer[] = [];
    #diagnostic = Buffer.alloc(0);
    #remoteEnded = false;
    #finSent = false;
    #transportClosed = false;

    constructor(attach: Duplex) {
        super({ allowHalfOpen: true });
        this.#attach = attach;
        this.#ready = new Promise<void>((resolve, reject) => {
            this.#resolveReady = resolve;
            this.#rejectReady = reject;
        });
        // A rejection nobody awaits yet must not crash the process; `open` awaits it.
        this.#ready.catch(() => undefined);
        this.on("error", holdBeforeOpen);
        attach.on("data", (chunk: Buffer) => this.#receive(chunk));
        attach.once("end", () => this.#transportEnded());
        attach.once("close", () => {
            this.#transportClosed = true;
            this.#transportEnded();
        });
        attach.on("error", (error: Error) =>
            this.#fail(
                withCode(
                    `The connection inside the container failed: ${error.message}`,
                    "ECONNRESET",
                ),
            ),
        );
    }

    /**
     * Wait until the helper has connected, then hand the connection over: from here its errors are
     * emitted to the caller's listeners alone. One that already failed or closed is refused with
     * its failure instead, never handed over dead.
     */
    async open(): Promise<this> {
        await this.#ready;
        if (this.destroyed) {
            throw (
                this.#failure ??
                withCode("The connection was closed before it opened.", "ECONNABORTED")
            );
        }
        this.off("error", holdBeforeOpen);
        return this;
    }

    /** Give up before the connection is ready: the helper exits once the attach stream closes. */
    abandon(error: Error): void {
        this.#fail(error);
    }

    /** Stop the helper now, including one still delivering a cleanly finished connection. */
    abort(): void {
        this.destroy();
        this.#attach.destroy();
    }

    override _read(): void {
        if (this.#state === "open") this.#attach.resume();
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        if (this.#state !== "open") {
            callback(withCode("The connection inside the container is not open.", "ENOTCONN"));
            return;
        }
        const frames: Buffer[] = [];
        for (let offset = 0; offset < chunk.byteLength; offset += MAX_FRAME_PAYLOAD) {
            const payload = chunk.subarray(offset, offset + MAX_FRAME_PAYLOAD);
            frames.push(frameHeader(FRAME_DATA, payload.byteLength), payload);
        }
        this.#attach.write(Buffer.concat(frames), (error) => callback(error ?? null));
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (this.#state !== "open") {
            callback();
            return;
        }
        // The half-close is written, and only then is the writable side finished: destroying the
        // attach stream any earlier could discard the frame and turn the half-close into an abort.
        this.#finSent = true;
        this.#attach.write(frameHeader(FRAME_FIN, 0), (error) => callback(error ?? null));
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        const connecting = this.#state === "connecting";
        const finishedCleanly =
            this.#state === "open" && error === null && this.#remoteEnded && this.writableFinished;
        this.#state = "closed";
        this.#failure = error;
        if (connecting) {
            this.#rejectReady(
                error ?? withCode("The connection was closed before it opened.", "ECONNABORTED"),
            );
        }
        if (finishedCleanly && !this.#transportClosed) {
            // Nothing more will be read, so nothing may hold the helper's output back.
            this.#attach.resume();
            const linger = setTimeout(() => this.#attach.destroy(), LINGER_MS);
            linger.unref();
            this.#attach.once("close", () => clearTimeout(linger));
        } else {
            this.#attach.destroy();
        }
        callback(error);
    }

    #receive(chunk: Buffer): void {
        let offset = 0;
        while (offset < chunk.byteLength && this.#state !== "closed") {
            if (this.#stdcopyRemaining === 0) {
                const needed = STDCOPY_HEADER_BYTES - this.#stdcopyHeader.byteLength;
                const taken = chunk.subarray(offset, offset + needed);
                offset += taken.byteLength;
                this.#stdcopyHeader = Buffer.concat([this.#stdcopyHeader, taken]);
                if (this.#stdcopyHeader.byteLength < STDCOPY_HEADER_BYTES) return;
                this.#stdcopyStream = this.#stdcopyHeader[0]!;
                this.#stdcopyRemaining = this.#stdcopyHeader.readUInt32BE(4);
                this.#stdcopyHeader = Buffer.alloc(0);
                continue;
            }
            const taken = chunk.subarray(offset, offset + this.#stdcopyRemaining);
            offset += taken.byteLength;
            this.#stdcopyRemaining -= taken.byteLength;
            if (this.#stdcopyStream === 1) this.#receiveOutput(taken);
            else if (this.#stdcopyStream === 2) this.#keepDiagnostic(taken);
            else this.#fail(protocolError("Docker sent output on an unknown stream."));
        }
    }

    #receiveOutput(bytes: Buffer): void {
        let offset = 0;
        while (offset < bytes.byteLength && this.#state !== "closed") {
            if (this.#frameRemaining === 0 && this.#frameHeader.byteLength < FRAME_HEADER_BYTES) {
                const needed = FRAME_HEADER_BYTES - this.#frameHeader.byteLength;
                const taken = bytes.subarray(offset, offset + needed);
                offset += taken.byteLength;
                this.#frameHeader = Buffer.concat([this.#frameHeader, taken]);
                if (this.#frameHeader.byteLength < FRAME_HEADER_BYTES) return;
                this.#frameType = this.#frameHeader[0]!;
                this.#frameRemaining = this.#frameHeader.readUInt32BE(1);
                this.#frameBody = [];
                if (!this.#frameAcceptable()) return;
                if (this.#frameRemaining === 0) this.#frameComplete();
                continue;
            }
            const taken = bytes.subarray(offset, offset + this.#frameRemaining);
            offset += taken.byteLength;
            this.#frameRemaining -= taken.byteLength;
            if (this.#frameType === FRAME_DATA) {
                if (!this.push(taken)) this.#attach.pause();
            } else {
                this.#frameBody.push(taken);
            }
            if (this.#frameRemaining === 0) this.#frameComplete();
        }
    }

    /** Whether the frame just announced can follow what came before it. */
    #frameAcceptable(): boolean {
        const type = this.#frameType;
        const length = this.#frameRemaining;
        const acceptable =
            length <= MAX_FRAME_PAYLOAD &&
            (this.#state === "connecting"
                ? type === FRAME_READY || type === FRAME_ERROR
                : (type === FRAME_DATA && length > 0 && !this.#remoteEnded) ||
                  (type === FRAME_FIN && length === 0 && !this.#remoteEnded) ||
                  type === FRAME_ERROR);
        if (!acceptable) {
            this.#fail(
                protocolError("The connection helper inside the container sent a malformed frame."),
            );
        }
        return acceptable;
    }

    #frameComplete(): void {
        const type = this.#frameType;
        const body = Buffer.concat(this.#frameBody);
        this.#frameHeader = Buffer.alloc(0);
        this.#frameBody = [];
        if (type === FRAME_READY) {
            if (body.toString("utf8") !== READY_PAYLOAD) {
                this.#fail(
                    withCode(
                        "The supervisor in this container speaks a different connection protocol. Recreate the container with this version's supervisor.",
                        "ENOTSUP",
                    ),
                );
                return;
            }
            this.#state = "open";
            this.#resolveReady();
            return;
        }
        if (type === FRAME_FIN) {
            this.#remoteEnded = true;
            this.push(null);
            return;
        }
        if (type === FRAME_ERROR) {
            const text = body.toString("utf8");
            const space = text.indexOf(" ");
            const code = space > 0 ? text.slice(0, space) : "ECONNRESET";
            const message = space > 0 ? text.slice(space + 1) : text;
            this.#fail(withCode(`The connection inside the container failed: ${message}`, code));
        }
    }

    #keepDiagnostic(bytes: Buffer): void {
        if (this.#diagnostic.byteLength >= MAX_DIAGNOSTIC_BYTES) return;
        this.#diagnostic = Buffer.concat([
            this.#diagnostic,
            bytes.subarray(0, MAX_DIAGNOSTIC_BYTES - this.#diagnostic.byteLength),
        ]);
    }

    /**
     * The helper has exited, or Docker dropped the stream. The helper exits on its own only once
     * both half-closes are done; anything else is a failure.
     */
    #transportEnded(): void {
        if (this.#state === "closed") return;
        if (this.#state === "connecting") {
            const diagnostic = this.#diagnostic.toString("utf8").trim();
            this.#fail(
                diagnostic.includes("unknown supervisor argument")
                    ? withCode(
                          "The supervisor in this container cannot open connections; it predates that feature. Recreate the container with this version's supervisor.",
                          "ENOTSUP",
                      )
                    : withCode(
                          `The connection helper inside the container stopped before connecting${diagnostic === "" ? "." : `: ${diagnostic}`}`,
                          "ECONNABORTED",
                      ),
            );
            return;
        }
        if (!this.#remoteEnded || !this.#finSent) {
            this.#fail(
                withCode("The connection inside the container ended unexpectedly.", "ECONNRESET"),
            );
        }
    }

    #fail(error: Error): void {
        if (this.#state === "closed") return;
        const connecting = this.#state === "connecting";
        this.#state = "closed";
        if (connecting) this.#rejectReady(error);
        this.destroy(connecting ? undefined : error);
    }
}

/** Keeps an error emitted before the hand-over from crashing the process; `open` reports it. */
function holdBeforeOpen(): void {}

function frameHeader(type: number, length: number): Buffer {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = type;
    header.writeUInt32BE(length, 1);
    return header;
}

function withCode(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function protocolError(message: string): Error {
    return withCode(message, "EPROTO");
}
