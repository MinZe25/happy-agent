import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import Dockerode from "dockerode";
import { resolveLinuxSupervisorBinary } from "@slopus/happy-agent-supervisor";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { computePermissions } from "../../sources/ComputePermissions.js";
import { createDockerCompute } from "../../sources/docker/createDockerCompute.js";

const LIVE = process.env.HAPPY_AGENT_COMPUTE_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
const itOnNativeLinux = process.platform === "linux" ? it : it.skip;
const image = process.env.HAPPY_AGENT_COMPUTE_DOCKER_IMAGE ?? "happy-agent-compute-test:local";
const apparmorProfile = process.env.HAPPY_AGENT_COMPUTE_DOCKER_APPARMOR_PROFILE;
const docker = new Dockerode();
const ctx: Context = createRootContext().named("happy-agent-compute-docker-live-test");
const computes = new Set<Compute>();
const temporaryDirectories = new Set<string>();
const cleanupContainers = new Set<string>();
const cleanupNetworks = new Set<string>();
const cleanupHostServers = new Set<() => Promise<void>>();

describeLive("live Docker compute boundary", () => {
    beforeAll(async () => {
        try {
            await docker.ping();
        } catch (error) {
            throw new Error(
                `HAPPY_AGENT_COMPUTE_LIVE_TEST=1 was set, but the Docker daemon is unavailable: ${errorMessage(error)}`,
            );
        }
        try {
            await docker.getImage(image).inspect();
        } catch (error) {
            throw new Error(
                `HAPPY_AGENT_COMPUTE_LIVE_TEST=1 requires the local image '${image}': ${errorMessage(error)}`,
            );
        }
    }, 30_000);

    afterEach(cleanUp);

    it("contains a restricted command while preserving workspace writes", async () => {
        const { compute } = await managedCompute();
        const fullAccess = computePermissions("full_access");
        const workspaceWrite = computePermissions("workspace_write");

        const precondition = await compute.shell.run({
            command:
                "printf precondition > /home/rig/live-precondition && rm /home/rig/live-precondition",
            permissions: fullAccess,
        });
        expect(precondition.exitCode).toBe(0);

        const result = await compute.shell.run({
            command: [
                "printf inside > /workspace/inside.txt",
                "printf escaped > /home/rig/outside.txt",
            ].join("\n"),
            permissions: workspaceWrite,
        });

        expect(result.exitCode).not.toBe(0);
        await expect(compute.fs.readFile(fullAccess, "/workspace/inside.txt")).resolves.toBe(
            "inside",
        );
        await expect(compute.fs.exists(fullAccess, "/home/rig/outside.txt")).resolves.toBe(false);
    }, 60_000);

    it("atomically refuses a final-component symlink during a live swap race", async () => {
        const { compute } = await managedCompute();
        const fullAccess = computePermissions("full_access");
        const sessionId = await compute.shell.startSession({
            command: [
                "set -eu",
                "mkdir -p /workspace/race",
                "chmod 0777 /workspace/race",
                "printf secret-live-value > /home/rig/secret.txt",
                "printf safe > /workspace/race/candidate",
                "touch /workspace/race/ready",
                "while [ ! -e /workspace/race/stop ]; do",
                "  ln -sfn /home/rig/secret.txt /workspace/race/next",
                "  mv -f /workspace/race/next /workspace/race/candidate",
                "  printf safe > /workspace/race/next",
                "  mv -f /workspace/race/next /workspace/race/candidate",
                "done",
            ].join("\n"),
            permissions: fullAccess,
        });

        await vi.waitFor(
            async () => {
                await expect(compute.fs.exists(fullAccess, "/workspace/race/ready")).resolves.toBe(
                    true,
                );
            },
            { timeout: 10_000 },
        );

        let regularReads = 0;
        let refusedLinks = 0;
        for (let index = 0; index < 150; index += 1) {
            let content: string | undefined;
            try {
                content = Buffer.from(
                    await compute.fs.readFileBuffer(fullAccess, "/workspace/race/candidate", {
                        noFollow: true,
                    }),
                ).toString("utf8");
            } catch (error) {
                expect(errorMessage(error)).toMatch(
                    /symbolic link|not a regular file|invalid archive/u,
                );
                refusedLinks += 1;
                continue;
            }
            expect(content).toBe("safe");
            regularReads += 1;
        }
        expect(regularReads).toBeGreaterThan(0);
        expect(refusedLinks).toBeGreaterThan(0);

        await compute.fs.writeFile(fullAccess, "/workspace/race/stop", "");
        await vi.waitFor(
            async () => {
                await expect(
                    compute.shell.readSession(sessionId, { peek: true }),
                ).resolves.toMatchObject({ status: "completed" });
            },
            { timeout: 10_000 },
        );
    }, 60_000);

    // The native supervisor's egress proxy runs inside the container. Docker Desktop does not
    // provide the same Linux namespace behavior as a native Linux daemon, so this case stays in
    // the native-Linux lane that the release runs.
    itOnNativeLinux(
        "allows and denies real egress through the native supervisor",
        async () => {
            const { compute } = await managedCompute();
            const request = proxyRequestCommand("example.com");
            const allowed = await compute.shell.run({
                command: request,
                permissions: computePermissions("workspace_write", {
                    network: {
                        egress: true,
                        allowedHosts: ["example.com"],
                        localBinding: false,
                    },
                }),
                timeoutMs: 20_000,
            });
            expect(allowed.exitCode, JSON.stringify(allowed)).toBe(0);
            expect(allowed.stdout).toMatch(/^status:[1-5]\d\d$/mu);

            const denied = await compute.shell.run({
                command: request,
                permissions: computePermissions("workspace_write", {
                    network: {
                        egress: true,
                        allowedHosts: ["example.org"],
                        localBinding: false,
                    },
                }),
                timeoutMs: 20_000,
            });
            expect(denied.exitCode, JSON.stringify(denied)).not.toBe(0);
        },
        90_000,
    );

    it("marks a timed-out session without killing the container process", async () => {
        const { compute } = await managedCompute();
        const permissions = computePermissions("full_access");
        const sessionId = await compute.shell.startSession({
            command: [
                "printf started > /workspace/timeout-started",
                "while [ ! -e /workspace/release-timeout ]; do :; done",
                "printf survived > /workspace/timeout-survived",
            ].join("\n"),
            permissions,
            timeoutMs: 10,
        });

        await vi.waitFor(
            async () => {
                await expect(
                    compute.fs.exists(permissions, "/workspace/timeout-started"),
                ).resolves.toBe(true);
                await expect(
                    compute.shell.readSession(sessionId, { peek: true }),
                ).resolves.toMatchObject({ status: "running", timedOut: true });
            },
            { timeout: 10_000 },
        );

        await compute.fs.writeFile(permissions, "/workspace/release-timeout", "");
        await vi.waitFor(
            async () => {
                await expect(
                    compute.shell.readSession(sessionId, { peek: true }),
                ).resolves.toMatchObject({ status: "completed", timedOut: true });
                await expect(
                    compute.fs.readFile(permissions, "/workspace/timeout-survived"),
                ).resolves.toBe("survived");
            },
            { timeout: 10_000 },
        );
    }, 60_000);

    it("removes a managed container on disposal", async () => {
        const name = `happy-compute-managed-live-${randomUUID()}`;
        const { compute } = await managedCompute(name);
        await compute.fs.exists(computePermissions("full_access"), "/workspace");
        await expect(docker.getContainer(name).inspect()).resolves.toMatchObject({
            State: { Running: true },
        });

        await compute.dispose(ctx);
        computes.delete(compute);

        await expect(docker.getContainer(name).inspect()).rejects.toMatchObject({
            statusCode: 404,
        });
    }, 60_000);

    it("leaves an explicitly attached container running on disposal", async () => {
        const name = `happy-compute-attached-live-${randomUUID()}`;
        cleanupContainers.add(name);
        const container = await docker.createContainer({
            name,
            Image: image,
            Entrypoint: ["/bin/sh", "-c"],
            Cmd: ["trap : TERM INT; while :; do sleep 3600; done"],
            HostConfig: {
                SecurityOpt: ["seccomp=unconfined", "apparmor=unconfined"],
                MaskedPaths: [],
                ReadonlyPaths: [],
            },
            WorkingDir: "/workspace",
        });
        await container.start();
        const compute = createDockerCompute({
            client: docker,
            docker: { container: name, workingDirectory: "/workspace" },
            sessionId: randomUUID(),
        });
        computes.add(compute);
        await compute.fs.exists(computePermissions("full_access"), "/workspace");

        await compute.dispose(ctx);
        computes.delete(compute);

        await expect(container.inspect()).resolves.toMatchObject({ State: { Running: true } });
    }, 60_000);
});

// Connections are the product's, not the agent's: they come from inside the container, outside
// any command sandbox, through the mounted supervisor's `--connect` mode.
describeLive("live Docker compute connections", () => {
    afterEach(cleanUp);

    it("reaches the container's own loopback, not the host's on the same port", async () => {
        const hostPort = await hostSentinel("host");
        const { compute, hostWorkspace } = await managedCompute();
        await startContainerServer(compute, hostWorkspace, [
            "reply",
            "127.0.0.1",
            hostPort,
            "container",
        ]);

        const socket = await connectWhenListening(compute, "127.0.0.1", hostPort);

        await expect(readAll(socket).then(String)).resolves.toBe("container");
    }, 60_000);

    it("delivers a large binary reply after the caller finishes sending", async () => {
        const { compute, hostWorkspace } = await managedCompute();
        await startContainerServer(compute, hostWorkspace, ["echo", "127.0.0.1", 7101]);
        const request = randomBytes(6 * 1024 * 1024 + 11);

        const socket = await connectWhenListening(compute, "127.0.0.1", 7101);
        const replied = readAll(socket);
        socket.end(request);

        expect(digest(await replied)).toBe(digest(request));
    }, 60_000);

    it("keeps sending a large binary body after the remote end finishes", async () => {
        const { compute, hostWorkspace } = await managedCompute();
        await startContainerServer(compute, hostWorkspace, ["greet", "127.0.0.1", 7102]);
        const request = randomBytes(6 * 1024 * 1024 + 13);

        const socket = await connectWhenListening(compute, "127.0.0.1", 7102);
        await expect(readAll(socket).then(String)).resolves.toBe("greeting");
        socket.end(request);

        const received = await waitFor(async () => {
            const text = await readFile(join(hostWorkspace, "received-7102"), "utf8").catch(
                () => "",
            );
            return text.length === 64 ? text : undefined;
        });
        expect(received).toBe(digest(request));
    }, 60_000);

    it("stops the helper in the container when aborted while the remote end ignores the half-close", async () => {
        const { compute, hostWorkspace } = await managedCompute();
        await startContainerServer(compute, hostWorkspace, ["hold", "127.0.0.1", 7103]);

        const socket = await connectWhenListening(compute, "127.0.0.1", 7103);
        socket.end("unanswered");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await connectHelpers(compute)).toBe(1);
        socket.destroy();

        await waitFor(async () => ((await connectHelpers(compute)) === 0 ? true : undefined));
    }, 60_000);

    it("resolves names the container's own DNS knows, such as a network alias", async () => {
        const network = `happy-compute-net-${randomUUID()}`;
        await docker.createNetwork({ Name: network });
        cleanupNetworks.add(network);
        const peer = `happy-compute-peer-${randomUUID()}`;
        cleanupContainers.add(peer);
        const peerContainer = await docker.createContainer({
            name: peer,
            Image: image,
            Entrypoint: ["node", "-e"],
            Cmd: [
                'require("node:net").createServer((socket) => socket.end("peer")).listen(8080, "0.0.0.0")',
            ],
            HostConfig: { NetworkMode: network },
            NetworkingConfig: {
                EndpointsConfig: { [network]: { Aliases: ["peer-service.internal"] } },
            },
        });
        await peerContainer.start();
        const client = `happy-compute-client-${randomUUID()}`;
        cleanupContainers.add(client);
        const architecture = process.arch === "arm64" ? "arm64" : "x64";
        const clientContainer = await docker.createContainer({
            name: client,
            Image: image,
            Entrypoint: ["/bin/sh", "-c"],
            Cmd: ["trap : TERM INT; while :; do sleep 3600; done"],
            HostConfig: {
                NetworkMode: network,
                Mounts: [
                    {
                        Type: "bind",
                        Source: resolveLinuxSupervisorBinary(architecture),
                        Target: "/tools/happy-agent-sandbox",
                        ReadOnly: true,
                    },
                ],
            },
            WorkingDir: "/workspace",
        });
        await clientContainer.start();
        const compute = createDockerCompute({
            client: docker,
            docker: { container: client, workingDirectory: "/workspace", architecture },
            sessionId: randomUUID(),
        });
        computes.add(compute);

        const socket = await connectWhenListening(compute, "peer-service.internal", 8080);

        await expect(readAll(socket).then(String)).resolves.toBe("peer");
    }, 60_000);
});

async function cleanUp(): Promise<void> {
    await Promise.all([...computes].map((compute) => compute.dispose(ctx)));
    computes.clear();
    await Promise.all(
        [...cleanupContainers].map((name) =>
            docker
                .getContainer(name)
                .remove({ force: true })
                .catch(() => undefined),
        ),
    );
    cleanupContainers.clear();
    await Promise.all(
        [...cleanupNetworks].map((name) =>
            docker
                .getNetwork(name)
                .remove()
                .catch(() => undefined),
        ),
    );
    cleanupNetworks.clear();
    await Promise.all([...cleanupHostServers].map((close) => close()));
    cleanupHostServers.clear();
    await Promise.all(
        [...temporaryDirectories].map((path) => rm(path, { force: true, recursive: true })),
    );
    temporaryDirectories.clear();
}

/** One small program for the cases above, run inside the container from the mounted workspace. */
const CONTAINER_SERVER = `
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

const [mode, host, port, reply] = process.argv.slice(2);
createServer({ allowHalfOpen: true }, (socket) => {
    if (mode === "reply") return void socket.end(reply);
    if (mode === "hold") return void socket.resume();
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    if (mode === "greet") socket.end("greeting");
    socket.on("end", () => {
        const body = Buffer.concat(chunks);
        if (mode === "echo") socket.end(body);
        if (mode === "greet") {
            const digest = createHash("sha256").update(body).digest("hex");
            writeFileSync("/workspace/received-" + port, digest);
        }
    });
}).listen(Number(port), host);
`;

async function startContainerServer(
    compute: Compute,
    hostWorkspace: string,
    args: ReadonlyArray<string | number>,
): Promise<void> {
    await writeFile(join(hostWorkspace, "server.mjs"), CONTAINER_SERVER);
    await compute.shell.startSession({
        command: `node /workspace/server.mjs ${args.map((arg) => shellQuote(String(arg))).join(" ")}`,
        permissions: computePermissions("full_access"),
    });
}

/** Connect once the program inside the container listens; a refusal means not yet. */
async function connectWhenListening(compute: Compute, host: string, port: number): Promise<Duplex> {
    const deadline = Date.now() + 20_000;
    for (;;) {
        try {
            return await compute.network!.connect(ctx, { host, port });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const retry = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
            if (!retry || Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}

/** How many `--connect` helpers run in the container. The bracket keeps grep from counting itself. */
async function connectHelpers(compute: Compute): Promise<number> {
    const result = await compute.shell.run({
        command:
            'for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f"; echo; done 2>/dev/null | grep -c -- "--connec[t]" || true',
        permissions: computePermissions("full_access"),
    });
    return Number(result.stdout.trim());
}

/** A server on the host's loopback that answers with `reply`, to show which machine was reached. */
async function hostSentinel(reply: string): Promise<number> {
    const server = createServer((socket) => socket.end(reply));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanupHostServers.add(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as AddressInfo).port;
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error("The expected state never arrived.");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function readAll(socket: Duplex): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.once("end", () => resolve(Buffer.concat(chunks)));
        socket.once("error", reject);
    });
}

function digest(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

async function managedCompute(name = `happy-compute-live-${randomUUID()}`): Promise<{
    compute: Compute;
    hostWorkspace: string;
}> {
    const hostWorkspace = await mkdtemp(join(tmpdir(), "happy-compute-docker-live-"));
    temporaryDirectories.add(hostWorkspace);
    await chmod(hostWorkspace, 0o777);
    const compute = createDockerCompute({
        client: docker,
        docker: {
            image,
            ...(apparmorProfile === undefined ? {} : { apparmorProfile }),
            mounts: [{ source: hostWorkspace, target: "/workspace" }],
            name,
            workingDirectory: "/workspace",
        },
        sessionId: randomUUID(),
    });
    computes.add(compute);
    return { compute, hostWorkspace };
}

function proxyRequestCommand(host: string): string {
    const script = [
        `fetch("https://${host}/", { signal: AbortSignal.timeout(15_000) })`,
        "  .then(async response => {",
        "    console.log(`status:${response.status}`);",
        "    await response.body?.cancel();",
        "    process.exit(response.status >= 100 && response.status <= 599 ? 0 : 25);",
        "  })",
        "  .catch(error => { console.error(error); process.exit(24); });",
    ].join("\n");
    return `node -e ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
