import type { Duplex } from "node:stream";

import type { Context } from "@steve.kite/stdlib";

import type { ComputeConnectOptions, ComputeNetwork } from "../ComputeNetwork.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";
import { DockerConnection } from "./impl/DockerConnection.js";

/** How long a connection may take to establish, matching the host. */
const DOCKER_CONNECT_TIMEOUT_MS = 30_000;

/** The Docker network, with a way to end every connection it opened. */
export interface DockerNetwork extends ComputeNetwork {
    /** Abort every open connection and refuse new ones, as disposing the compute does. */
    close(): void;
}

/**
 * Connections made from inside the container, in its own network namespace.
 *
 * Each connection is the mounted supervisor's `--connect` mode, started with `docker exec`, so the
 * container's own resolver, network aliases, and loopback apply and the image needs no network
 * tools. It runs outside any command sandbox — this is the product's connection, not the agent's —
 * but never outside the container. There is no `listen`: nothing here needs the container to
 * reach back to the caller.
 */
export function createDockerNetwork(environment: DockerEnvironment): DockerNetwork {
    const open = new Set<DockerConnection>();
    let closed = false;
    const refuseClosed = () =>
        Object.assign(new Error("This Docker compute has been disposed."), {
            code: "ECONNABORTED",
        });

    const connect = async (_ctx: Context, options: ComputeConnectOptions): Promise<Duplex> => {
        if (closed) throw refuseClosed();
        const timedOut = () =>
            Object.assign(
                new Error(
                    `Connecting to ${options.host}:${String(options.port)} inside the container timed out.`,
                ),
                { code: "ETIMEDOUT" },
            );
        let connection: DockerConnection | undefined;
        let expired = false;
        let expire!: (error: Error) => void;
        const expiry = new Promise<never>((_resolve, reject) => {
            expire = reject;
        });
        // The deadline covers reaching the container as well as the connection inside it.
        const timer = setTimeout(() => {
            expired = true;
            const error = timedOut();
            connection?.abandon(error);
            expire(error);
        }, DOCKER_CONNECT_TIMEOUT_MS);
        timer.unref();
        const opening = (async () => {
            const [container, supervisor] = await Promise.all([
                environment.container(),
                environment.supervisorMount(),
            ]);
            const exec = await container.exec({
                AttachStdin: true,
                AttachStdout: true,
                AttachStderr: true,
                Cmd: [supervisor, "--connect", options.host, String(options.port)],
                Tty: false,
            });
            const attach = await exec.start({ hijack: true, stdin: true, Tty: false });
            // Closing the attach stream is what stops the helper, so one that arrives too late is
            // closed rather than left running.
            if (expired || closed) {
                attach.destroy();
                throw expired ? timedOut() : refuseClosed();
            }
            const opened = new DockerConnection(attach);
            connection = opened;
            // Tracked until the helper is gone, which can be after a clean finish closed the duplex.
            open.add(opened);
            attach.once("close", () => open.delete(opened));
            return await opened.open();
        })();
        try {
            return await Promise.race([opening, expiry]);
        } finally {
            clearTimeout(timer);
        }
    };

    return {
        connect,
        close() {
            closed = true;
            for (const connection of Array.from(open)) connection.abort();
        },
    };
}
