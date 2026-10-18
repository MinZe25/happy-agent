import { chmod, unlink } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    createServer,
    request as requestHttp,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import { Duplex } from "node:stream";

const CONNECT_TIMEOUT_MS = 30_000;
/** How long a route waits for the attachment it was made for before it is forgotten. */
const ROUTE_TTL_MS = 60_000;
/** Carries a route from the Bun front door to this listener; never forwarded upstream. */
export const WORKSPACE_PROXY_ROUTE_HEADER = "x-happy-proxy-route";

/** Opens a connection from the workspace's own network. */
export type WorkspaceProxyConnector = (host: string, port: number) => Promise<Duplex>;

/** The loopback TCP hop Bun front doors forward workspace tunnels to, and how they are admitted. */
export interface WorkspaceProxyTcpHop {
    readonly port: number;
    /** The `Proxy-Authorization` value the front door adds to each connection's first request. */
    readonly authorization: string;
}

/**
 * HTTP/1.1 forward proxy spoken inside the workspace CONNECT attachment.
 *
 * A folder on this machine reaches this machine's network directly. A folder on a runner reaches
 * the runner's: its attachment is admitted with a route, a one-time key naming how to connect from
 * there, and every request and tunnel on that attachment then opens its connection through it.
 */
export class WorkspaceProxy {
    /** Attachments handed over directly, and the private Unix socket. Both are owner-only. */
    readonly #server = createServer();
    /**
     * Loopback TCP, which any local process can reach, so each connection is admitted by a
     * memory-only credential. Every front door shares this one hop.
     */
    readonly #tcpServer = createServer();
    readonly #sockets = new Set<Duplex>();
    #socketPath: string | undefined;
    #tcpHop: Promise<WorkspaceProxyTcpHop> | undefined;
    #tcpToken: string | undefined;
    readonly #admitted = new WeakSet<Duplex>();
    readonly #connectors = new WeakMap<Duplex, WorkspaceProxyConnector>();
    readonly #routes = new Map<
        string,
        { readonly connector: WorkspaceProxyConnector; readonly timer: NodeJS.Timeout }
    >();

    constructor() {
        this.#serve(this.#server, false);
        this.#serve(this.#tcpServer, true);
    }

    #serve(server: ReturnType<typeof createServer>, admitted: boolean): void {
        server.on("request", (request, response) => {
            if (admitted && !this.#admit(request)) {
                sendProxyError(response, 407, "Proxy authentication is required.");
                return;
            }
            this.#forwardRequest(request, response);
        });
        server.on("connect", (request, socket, head) => {
            if (admitted && !this.#admit(request)) {
                refuse(socket, 407, "Proxy Authentication Required");
                return;
            }
            this.#openTunnel(request, socket, head);
        });
        server.on("connection", (socket) => {
            this.#sockets.add(socket);
            socket.once("close", () => {
                this.#sockets.delete(socket);
            });
        });
        server.on("clientError", (_error, socket) => {
            refuse(socket, 400, "Bad Request");
        });
    }

    /**
     * Registers how one attachment's connections are made, returning the one-time key that
     * attachment presents. A key nobody presents within a minute is forgotten.
     */
    route(connector: WorkspaceProxyConnector): string {
        const key = randomBytes(24).toString("base64url");
        const timer = setTimeout(() => this.#routes.delete(key), ROUTE_TTL_MS);
        timer.unref();
        this.#routes.set(key, { connector, timer });
        return key;
    }

    accept(socket: Socket, head: Buffer, route?: string): void {
        const connector = route === undefined ? undefined : this.#take(route);
        if (connector !== undefined) this.#connectors.set(socket, connector);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
            if (head.byteLength > 0) socket.unshift(head);
            this.#server.emit("connection", socket);
            socket.resume();
        });
    }

    async listen(path: string): Promise<void> {
        if (this.#socketPath !== undefined) {
            if (this.#socketPath === path) return;
            throw new Error("The workspace HTTP proxy is already listening.");
        }
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error): void => {
                this.#server.off("listening", listening);
                reject(error);
            };
            const listening = (): void => {
                this.#server.off("error", failed);
                resolve();
            };
            this.#server.once("error", failed);
            this.#server.once("listening", listening);
            this.#server.listen(path);
        });
        this.#socketPath = path;
        await chmod(path, 0o600);
    }

    /**
     * The loopback TCP hop for Bun front doors, opened on first use. Every caller receives the same
     * hop, so a second front door beside the first, Unix socket or not, shares it.
     */
    async listenTcp(): Promise<WorkspaceProxyTcpHop> {
        this.#tcpHop ??= this.#openTcp();
        try {
            return await this.#tcpHop;
        } catch (error) {
            this.#tcpHop = undefined;
            throw error;
        }
    }

    async #openTcp(): Promise<WorkspaceProxyTcpHop> {
        const token = randomBytes(32).toString("base64url");
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error): void => {
                this.#tcpServer.off("listening", listening);
                reject(error);
            };
            const listening = (): void => {
                this.#tcpServer.off("error", failed);
                resolve();
            };
            this.#tcpServer.once("error", failed);
            this.#tcpServer.once("listening", listening);
            this.#tcpServer.listen({ host: "127.0.0.1", port: 0 });
        });
        const address = this.#tcpServer.address();
        if (address === null || typeof address === "string") {
            throw new Error("The workspace HTTP proxy is not listening on TCP.");
        }
        this.#tcpToken = token;
        return { port: address.port, authorization: `Bearer ${token}` };
    }

    #admit(request: IncomingMessage): boolean {
        const token = this.#tcpToken;
        if (token === undefined) return false;
        const authorization = request.headers["proxy-authorization"];
        delete request.headers["proxy-authorization"];
        if (this.#admitted.has(request.socket)) return true;
        const expected = `Bearer ${token}`;
        if (
            typeof authorization !== "string" ||
            Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
        )
            return false;
        this.#admitted.add(request.socket);
        return true;
    }

    #take(route: string): WorkspaceProxyConnector | undefined {
        const entry = this.#routes.get(route);
        if (entry === undefined) return undefined;
        this.#routes.delete(route);
        clearTimeout(entry.timer);
        return entry.connector;
    }

    /** How this request's connection reaches its target, when it is not this machine's network. */
    #connectorFor(request: IncomingMessage): WorkspaceProxyConnector | undefined {
        const route = request.headers[WORKSPACE_PROXY_ROUTE_HEADER];
        delete request.headers[WORKSPACE_PROXY_ROUTE_HEADER];
        const existing = this.#connectors.get(request.socket);
        if (existing !== undefined || typeof route !== "string") return existing;
        const connector = this.#take(route);
        if (connector !== undefined) this.#connectors.set(request.socket, connector);
        return connector;
    }

    async close(): Promise<void> {
        for (const { timer } of this.#routes.values()) clearTimeout(timer);
        this.#routes.clear();
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        const path = this.#socketPath;
        this.#socketPath = undefined;
        this.#tcpHop = undefined;
        this.#tcpToken = undefined;
        await Promise.all([closeServer(this.#server), closeServer(this.#tcpServer)]);
        if (path === undefined) return;
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
    }

    #forwardRequest(request: IncomingMessage, response: ServerResponse): void {
        let target: URL;
        try {
            target = new URL(request.url ?? "");
        } catch {
            sendProxyError(response, 400, "The proxy request URL is invalid.");
            return;
        }
        if (target.protocol !== "http:") {
            sendProxyError(response, 501, "Use CONNECT for protocols other than plain HTTP.");
            return;
        }
        const connector = this.#connectorFor(request);
        const headers = { ...request.headers };
        delete headers["proxy-connection"];
        const hostname = target.hostname;
        const port = target.port === "" ? 80 : Number(target.port);
        const upstream = requestHttp(
            {
                hostname,
                port,
                path: `${target.pathname}${target.search}`,
                method: request.method,
                headers,
                signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
                ...(connector === undefined
                    ? {}
                    : { createConnection: () => deferredDuplex(connector(hostname, port)) }),
            },
            (upstreamResponse) => {
                response.writeHead(
                    upstreamResponse.statusCode ?? 502,
                    upstreamResponse.statusMessage,
                    upstreamResponse.headers,
                );
                upstreamResponse.pipe(response);
            },
        );
        upstream.on("error", () => {
            if (!response.headersSent) {
                sendProxyError(response, 502, "The proxied service could not be reached.");
            } else {
                response.destroy();
            }
        });
        request.pipe(upstream);
    }

    #openTunnel(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        let target: URL;
        try {
            target = new URL(`http://${request.url ?? ""}`);
        } catch {
            refuse(socket, 400, "Bad Request");
            return;
        }
        const port = target.port === "" ? 80 : Number(target.port);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
            refuse(socket, 400, "Bad Request");
            return;
        }
        const connector = this.#connectorFor(request);
        if (connector !== undefined) {
            this.#openRoutedTunnel(connector, target.hostname, port, socket, head);
            return;
        }
        const upstream = connectTcp({
            host: target.hostname,
            port,
        });
        const timeout = setTimeout(() => {
            upstream.destroy();
            refuse(socket, 504, "Gateway Timeout");
        }, CONNECT_TIMEOUT_MS);
        timeout.unref();
        upstream.once("connect", () => {
            clearTimeout(timeout);
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.byteLength > 0) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.once("error", () => {
            clearTimeout(timeout);
            refuse(socket, 502, "Bad Gateway");
        });
        socket.once("close", () => upstream.destroy());
    }

    #openRoutedTunnel(
        connector: WorkspaceProxyConnector,
        hostname: string,
        port: number,
        socket: Duplex,
        head: Buffer,
    ): void {
        let settled = false;
        const timeout = setTimeout(() => {
            settled = true;
            refuse(socket, 504, "Gateway Timeout");
        }, CONNECT_TIMEOUT_MS);
        timeout.unref();
        connector(hostname, port).then(
            (upstream) => {
                clearTimeout(timeout);
                if (settled || socket.destroyed) {
                    upstream.destroy();
                    return;
                }
                settled = true;
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.byteLength > 0) upstream.write(head);
                upstream.pipe(socket);
                socket.pipe(upstream);
                upstream.once("error", () => socket.destroy());
                socket.once("error", () => upstream.destroy());
                socket.once("close", () => upstream.destroy());
            },
            () => {
                clearTimeout(timeout);
                if (settled) return;
                settled = true;
                refuse(socket, 502, "Bad Gateway");
            },
        );
    }
}

/**
 * A stream usable the moment HTTP asks for a connection, while the real one is still being opened
 * elsewhere. Writes wait for it; a connection that cannot be opened fails the request.
 */
function deferredDuplex(opening: Promise<Duplex>): Duplex {
    let upstream: Duplex | undefined;
    const waiting: { chunk: Buffer; callback: (error?: Error | null) => void }[] = [];
    let ending: (() => void) | undefined;
    const stream = new Duplex({
        read() {
            upstream?.resume();
        },
        write(chunk: Buffer, _encoding, callback) {
            if (upstream === undefined) waiting.push({ chunk, callback });
            else upstream.write(chunk, callback);
        },
        final(callback) {
            if (upstream === undefined) ending = () => upstream?.end(callback);
            else upstream.end(callback);
        },
        destroy(error, callback) {
            upstream?.destroy();
            callback(error);
        },
    });
    opening.then(
        (opened) => {
            if (stream.destroyed) {
                opened.destroy();
                return;
            }
            upstream = opened;
            opened.on("data", (chunk: Buffer) => {
                if (!stream.push(chunk)) opened.pause();
            });
            opened.once("end", () => stream.push(null));
            opened.once("error", (error) => stream.destroy(error));
            opened.once("close", () => stream.destroy());
            for (const { chunk, callback } of waiting.splice(0)) opened.write(chunk, callback);
            ending?.();
        },
        (error: unknown) => {
            stream.destroy(error instanceof Error ? error : new Error(String(error)));
        },
    );
    return stream;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    }).catch((error: unknown) => {
        if (!(error instanceof Error) || !/not running/i.test(error.message)) throw error;
    });
}

function sendProxyError(response: ServerResponse, status: number, message: string): void {
    const body = Buffer.from(message);
    response.writeHead(status, {
        connection: "close",
        "content-length": body.byteLength,
        "content-type": "text/plain; charset=utf-8",
    });
    response.end(body);
}

function refuse(socket: Duplex, status: number, statusText: string): void {
    if (socket.destroyed) return;
    socket.end(
        `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}
