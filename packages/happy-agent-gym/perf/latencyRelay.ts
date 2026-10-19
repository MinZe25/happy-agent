/**
 * Stands in for the Tailcat carrier between a daemon and a remote one on the same machine: it
 * accepts on one Unix socket, connects each client to the remote daemon's socket, and holds every
 * chunk for half the round trip in each direction, so a remote answers as late as one across a
 * network would. Order is kept: each direction releases its chunks in the order they arrived.
 *
 * Usage: node --import tsx perf/latencyRelay.ts <listen socket> <remote socket> <round trip ms>
 */
import { rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";

const [listenPath, remotePath, roundTrip] = process.argv.slice(2);
if (listenPath === undefined || remotePath === undefined || roundTrip === undefined) {
    throw new Error("Usage: latencyRelay.ts <listen socket> <remote socket> <round trip ms>");
}
const oneWayMs = Number(roundTrip) / 2;

/** Copies `from` into `to` with the one-way delay, ending and destroying `to` with it. */
function delayed(from: Socket, to: Socket): void {
    from.on("data", (chunk: Buffer) => setTimeout(() => to.write(chunk), oneWayMs));
    from.once("end", () => setTimeout(() => to.end(), oneWayMs));
    from.once("close", () => setTimeout(() => to.destroy(), oneWayMs));
    from.on("error", () => undefined);
}

await rm(listenPath, { force: true });
const server = createServer((client) => {
    const remote = connect(remotePath);
    delayed(client, remote);
    delayed(remote, client);
});
server.listen(listenPath, () =>
    console.log(`latency relay ${listenPath} → ${remotePath}, ${roundTrip} ms`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
}
