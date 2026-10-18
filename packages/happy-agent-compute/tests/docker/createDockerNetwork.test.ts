import { createHash, randomBytes } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";

import type Dockerode from "dockerode";
import {
    resolveLinuxSupervisorBinary,
    resolveSupervisorBinary,
} from "@slopus/happy-agent-supervisor";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { createDockerCompute } from "../../sources/docker/createDockerCompute.js";
import { DOCKER_SUPERVISOR_PATH } from "../../sources/docker/impl/createDockerSupervisorCommand.js";
import { attachProcess } from "./impl/attachProcess.js";
import { READY, frame, stdcopy } from "./impl/connectFrames.js";

const ctx: Context = createRootContext().named("docker-network-test");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The real `--connect` helper runs as a local process in place of `docker exec`: everything but
// Docker's own transport is the production path. A locally built supervisor can be tested before
// it is published by naming it in HAPPY_AGENT_COMPUTE_SUPERVISOR_BINARY.
describe.runIf(process.platform !== "win32")("connections from a Docker compute", () => {
    it("runs the mounted supervisor's connect mode in the container", async () => {
        const server = await listen((socket) => {
            socket.end("ok");
        });
        const { compute, execs } = dockerCompute();

        const socket = await compute.network!.connect(ctx, {
            host: "127.0.0.1",
            port: server.port,
        });

        await expect(readAll(socket)).resolves.toEqual(Buffer.from("ok"));
        expect(execs).toEqual([
            {
                AttachStdin: true,
                AttachStdout: true,
                AttachStderr: true,
                Cmd: [DOCKER_SUPERVISOR_PATH, "--connect", "127.0.0.1", String(server.port)],
                Tty: false,
            },
        ]);
        expect(compute.network!.listen).toBeUndefined();
    });

    it("delivers the whole reply after the caller finishes sending", async () => {
        const request = randomBytes(1024 * 1024 + 17);
        const reply = randomBytes(3 * 1024 * 1024 + 5);
        let received: Buffer | undefined;
        const server = await listen(async (socket) => {
            received = await readAll(socket);
            socket.end(reply);
        });
        const { compute } = dockerCompute();

        const socket = await compute.network!.connect(ctx, {
            host: "localhost",
            port: server.port,
        });
        const replied = readAll(socket);
        socket.end(request);

        expect(digest(await replied)).toBe(digest(reply));
        expect(digest(received!)).toBe(digest(request));
    }, 30_000);

    it("keeps sending after the remote end finishes", async () => {
        // Read slowly throughout, so this side finishes, and its duplex closes, well before the
        // remote end has everything. Closing then must not cut the delivery short.
        const request = randomBytes(8 * 1024 * 1024 + 3);
        const received = deferred<Buffer>();
        const server = await listen((socket) => {
            socket.end("greeting");
            void readSlowly(socket).then(received.resolve, received.reject);
        });
        const { compute } = dockerCompute();

        const socket = await compute.network!.connect(ctx, {
            host: "127.0.0.1",
            port: server.port,
        });
        await expect(readAll(socket)).resolves.toEqual(Buffer.from("greeting"));
        expect(socket.writable).toBe(true);
        socket.end(request);

        expect(digest(await received.promise)).toBe(digest(request));
    }, 30_000);

    it("stops the helper when destroyed while the remote end ignores the half-close", async () => {
        const remote = deferred<Socket>();
        const server = await listen((socket) => {
            // Never answer and never end: only the caller's abort can finish this connection.
            socket.resume();
            remote.resolve(socket);
        });
        const { compute, helpers } = dockerCompute();

        const socket = await compute.network!.connect(ctx, {
            host: "127.0.0.1",
            port: server.port,
        });
        socket.end("unanswered");
        const accepted = await remote.promise;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(helpers[0]!.child.exitCode).toBeNull();
        socket.destroy();

        await expect(helpers[0]!.exited).resolves.toBe(0);
        // The remote end still holds its half open; writing into it now meets a closed socket.
        const closed = new Promise<void>((resolve) => accepted.once("close", resolve));
        const probe = setInterval(() => accepted.write("probe"), 20);
        await closed;
        clearInterval(probe);
    });

    it("slows the remote end down while its reader is behind", async () => {
        const total = 64 * 1024 * 1024;
        let accepted = 0;
        const server = await listen((socket) => {
            const chunk = Buffer.alloc(64 * 1024, 9);
            const pump = () => {
                while (accepted < total) {
                    accepted += chunk.byteLength;
                    if (!socket.write(chunk)) {
                        socket.once("drain", pump);
                        return;
                    }
                }
                socket.end();
            };
            pump();
        });
        const { compute } = dockerCompute();

        const socket = await compute.network!.connect(ctx, {
            host: "127.0.0.1",
            port: server.port,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const stalledAt = accepted;
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(accepted).toBe(stalledAt);
        expect(accepted).toBeLessThan(total / 2);
        await expect(readAll(socket).then((bytes) => bytes.byteLength)).resolves.toBe(total);
    }, 30_000);

    it("reports a refused connection with its code", async () => {
        const server = await listen(() => undefined);
        const port = server.port;
        await server.close();
        const { compute } = dockerCompute();

        await expect(
            compute.network!.connect(ctx, { host: "127.0.0.1", port }),
        ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    });

    it("aborts its open connections when the compute is disposed", async () => {
        const server = await listen((socket) => {
            socket.resume();
        });
        const { compute, helpers } = dockerCompute();
        const socket = await compute.network!.connect(ctx, {
            host: "127.0.0.1",
            port: server.port,
        });
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));

        await compute.dispose(ctx);

        await closed;
        await expect(helpers[0]!.exited).resolves.toBe(0);
        await expect(
            compute.network!.connect(ctx, { host: "127.0.0.1", port: server.port }),
        ).rejects.toThrow();
    });

    it("gives up, and closes the attach stream, when the connection never becomes ready", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const silent = new SilentAttach();
        const { compute } = dockerCompute(() => silent);

        const connecting = compute.network!.connect(ctx, { host: "10.255.255.1", port: 80 });
        const outcome = connecting.then(
            () => undefined,
            (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(30_000);

        await expect(outcome).resolves.toMatchObject({ code: "ETIMEDOUT" });
        expect(silent.destroyed).toBe(true);
    });

    // A remote end that resets at once can put READY and the failure in one Docker read, before
    // the caller holds the connection, let alone listens for its errors.
    it("refuses a connection that failed in the same read that opened it", async () => {
        const { compute } = dockerCompute(
            () =>
                new AnsweredAttach(
                    stdcopy(
                        1,
                        Buffer.concat([
                            frame("R", READY),
                            frame("X", Buffer.from("ECONNRESET Connection reset by peer")),
                        ]),
                    ),
                ),
        );

        await expect(
            compute.network!.connect(ctx, { host: "127.0.0.1", port: 80 }),
        ).rejects.toMatchObject({ code: "ECONNRESET" });
    });

    it("refuses a connection whose transport ended as it opened", async () => {
        const { compute } = dockerCompute(
            () => new AnsweredAttach(stdcopy(1, frame("R", READY)), { ended: true }),
        );

        await expect(
            compute.network!.connect(ctx, { host: "127.0.0.1", port: 80 }),
        ).rejects.toMatchObject({ code: "ECONNRESET" });
    });

    it("hands over a connection the remote end finished as it opened", async () => {
        const { compute } = dockerCompute(
            () =>
                new AnsweredAttach(
                    stdcopy(
                        1,
                        Buffer.concat([
                            frame("R", READY),
                            frame("D", Buffer.from("bye")),
                            frame("F"),
                        ]),
                    ),
                ),
        );

        const socket = await compute.network!.connect(ctx, { host: "127.0.0.1", port: 80 });

        await expect(readAll(socket)).resolves.toEqual(Buffer.from("bye"));
    });

    // Bun runs ticks between microtasks where Node runs them after, so where a failure lands
    // relative to the hand-over differs between runtimes. Either way it is refused or heard by the
    // caller's listener, attached as soon as the connection arrives, and never emitted to nobody.
    it("never emits a failure that arrives during the hand-over to nobody", async () => {
        const schedules: Array<[string, (deliver: () => void) => void]> = [
            ["in the next tick", (deliver) => process.nextTick(deliver)],
            ...Array.from({ length: 12 }, (_, index): [string, (deliver: () => void) => void] => [
                `${String(index + 1)} microtasks later`,
                (deliver) => afterMicrotasks(index + 1, deliver),
            ]),
        ];
        for (const [when, schedule] of schedules) {
            const { compute } = dockerCompute(() => {
                const attach = new AnsweredAttach(stdcopy(1, frame("R", READY)));
                attach.once("data", () => schedule(() => attach.push(RESET)));
                return attach;
            });

            const outcome = await compute
                .network!.connect(ctx, { host: "127.0.0.1", port: 80 })
                .then(
                    (socket) => new Promise<unknown>((resolve) => socket.once("error", resolve)),
                    (error: unknown) => error,
                );

            expect(outcome, when).toMatchObject({ code: "ECONNRESET" });
        }
    });

    it("leaves failures after the hand-over to the caller", async () => {
        const attach = new AnsweredAttach(stdcopy(1, frame("R", READY)));
        const { compute } = dockerCompute(() => attach);

        const socket = await compute.network!.connect(ctx, { host: "127.0.0.1", port: 80 });
        // Nothing else listens, so a caller that does not listen hears about it as from any stream.
        expect(socket.listenerCount("error")).toBe(0);
        const failed = new Promise<Error>((resolve) => socket.once("error", resolve));
        attach.push(stdcopy(1, frame("X", Buffer.from("ECONNRESET Connection reset by peer"))));

        await expect(failed).resolves.toMatchObject({ code: "ECONNRESET" });
    });
});

/**
 * An attach stream whose helper had already written `output` when Docker handed it over, so it
 * arrives as one read; with `ended`, the transport ends right behind it.
 */
class AnsweredAttach extends Duplex {
    constructor(output: Buffer, options: { ended?: boolean } = {}) {
        super();
        this.push(output);
        if (options.ended === true) this.push(null);
    }

    override _read(): void {}
    override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
        callback();
    }
}

/** The helper's report of a connection the remote end reset. */
const RESET = stdcopy(1, frame("X", Buffer.from("ECONNRESET Connection reset by peer")));

function afterMicrotasks(count: number, run: () => void): void {
    queueMicrotask(() => (count <= 1 ? run() : afterMicrotasks(count - 1, run)));
}

/** An attach stream whose helper never answers. */
class SilentAttach extends Duplex {
    override _read(): void {}
    override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
        callback();
    }
}

function dockerCompute(start?: (command: readonly string[]) => Duplex) {
    const binary = resolveSupervisorBinary(process.env.HAPPY_AGENT_COMPUTE_SUPERVISOR_BINARY);
    const execs: unknown[] = [];
    const helpers: Array<ReturnType<typeof attachProcess>> = [];
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    const container = {
        inspect: async () => ({
            State: { Running: true },
            Mounts: [
                {
                    Destination: DOCKER_SUPERVISOR_PATH,
                    Type: "bind",
                    RW: false,
                    Source: resolveLinuxSupervisorBinary(architecture),
                },
            ],
        }),
        exec: async (options: { Cmd: string[] }) => {
            execs.push(options);
            return {
                start: async () => {
                    if (start !== undefined) return start(options.Cmd);
                    const helper = attachProcess(binary, options.Cmd.slice(1));
                    helpers.push(helper);
                    cleanups.push(() => {
                        helper.child.kill("SIGKILL");
                    });
                    return helper.attach;
                },
            };
        },
    };
    const compute: Compute = createDockerCompute({
        client: { getContainer: () => container } as unknown as Dockerode,
        docker: { container: "dev", workingDirectory: "/work", architecture },
        sessionId: "docker-network-test",
    });
    cleanups.push(() => compute.dispose(ctx));
    return { compute, execs, helpers };
}

async function listen(
    onConnection: (socket: Socket) => void | Promise<void>,
): Promise<{ port: number; close(): Promise<void> }> {
    const sockets = new Set<Socket>();
    const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        void onConnection(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const close = () =>
        new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        });
    cleanups.push(close);
    return { port: (server.address() as AddressInfo).port, close };
}

function readAll(socket: Duplex): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.once("end", () => resolve(Buffer.concat(chunks)));
        socket.once("error", reject);
    });
}

/** Reads at most what Node has buffered every few milliseconds, until the end. */
function readSlowly(socket: Socket): Promise<Buffer> {
    socket.pause();
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const timer = setInterval(() => {
            const chunk = socket.read() as Buffer | null;
            if (chunk !== null) chunks.push(chunk);
        }, 5);
        socket.once("end", () => {
            clearInterval(timer);
            resolve(Buffer.concat(chunks));
        });
        socket.once("error", (error) => {
            clearInterval(timer);
            reject(error);
        });
    });
}

function digest(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
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
