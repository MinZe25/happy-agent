import { connect, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { WorkspaceBridge } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    BridgesModule,
    MAX_USB_BRIDGES,
    UsbAttachError,
    type BridgeAdmission,
    type BridgeEvent,
    type BridgeWebSocket,
    type BridgeWebSocketBinding,
    type UsbHostController,
    type UsbMachineProbe,
} from "../../sources/bridges/index.js";
import { encodeUsbImportRequest } from "../../sources/bridges/impl/usbipImport.js";
import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { projectMigrations, type ProjectsModule } from "../../sources/projects/index.js";
import { workspaceMigrations, type WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";
import { usbImportReply } from "./support/usbip.js";

const OWNER = "standalone";
const opened: World[] = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const world of opened.splice(0)) {
        await world.module.close();
        await world.close();
    }
});

describe("BridgesModule capabilities", () => {
    it("offers everything for a workspace on this machine, and says why when it cannot", async () => {
        const { controller, ctx, module, project } = await createWorld("bridges-capabilities");

        await expect(module.list(ctx, OWNER, project.id)).resolves.toEqual({
            capabilities: {
                usb: { available: true, reason: null },
                bluetooth: { available: true, transport: "usb", reason: null },
                localToWorkspace: { available: true, reason: null },
                workspaceToLocal: { available: true, reason: null },
            },
            bridges: [],
        });

        controller.machine = {
            usb: null,
            bluetooth: { code: "bluetooth_driver_missing", message: "No btusb." },
        };
        const { capabilities } = await module.list(ctx, OWNER, project.id);
        expect(capabilities.usb.available).toBe(true);
        expect(capabilities.bluetooth).toEqual({
            available: false,
            transport: "usb",
            reason: { code: "bluetooth_driver_missing", message: "No btusb." },
        });
    });

    it("announces a changed machine so clients reread what they show", async () => {
        const { controller, ctx, events, module, project } = await createWorld(
            "bridges-capability-change",
        );
        await module.list(ctx, OWNER, project.id);
        await module.list(ctx, OWNER, project.id);
        expect(events).toEqual([]);

        controller.machine = {
            usb: { code: "vhci_not_loaded", message: "Load vhci-hcd." },
            bluetooth: { code: "vhci_not_loaded", message: "Load vhci-hcd." },
        };
        await module.list(ctx, OWNER, project.id);

        expect(events).toEqual([{ type: "bridges.capabilities.updated", payload: {} }]);
    });

    it("answers for unknown, initializing, and archived workspaces as the workspace routes do", async () => {
        const { archivedProject, ctx, initializingWorkspace, module } = await createWorld(
            "bridges-workspace-states",
        );

        await expect(module.list(ctx, OWNER, "missing")).rejects.toMatchObject({
            code: "not_found",
        });
        await expect(module.list(ctx, OWNER, initializingWorkspace.id)).rejects.toMatchObject({
            code: "not_initialized",
        });
        await expect(module.list(ctx, OWNER, archivedProject.id)).rejects.toMatchObject({
            code: "conflict",
        });
    });
});

describe("USB bridges", () => {
    it("attaches the device its exporter offers and relays the connection both ways", async () => {
        const { controller, ctx, events, module, project } = await createWorld("bridges-usb-open");

        const webSocket = open(
            await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2", name: "Arduino Uno" }),
        );
        expect(webSocket.messages).toEqual([encodeUsbImportRequest("1-2")]);
        const reply = usbImportReply({ busId: "1-2", busnum: 3, devnum: 7 });
        webSocket.receive(reply.subarray(0, 100));
        webSocket.receive(reply.subarray(100));

        const kernel = await vi.waitFor(() => {
            const attached = controller.attached[0];
            if (attached === undefined) throw new Error("Not attached yet.");
            return attached;
        });
        expect(kernel.device).toEqual({ devid: (3 << 16) | 7, speed: 2 });
        const created = events[0];
        expect(created).toMatchObject({
            type: "bridge.created",
            ownerId: OWNER,
            payload: {
                bridge: {
                    kind: "usb",
                    name: "Arduino Uno",
                    status: "open",
                    workspaceId: project.id,
                    usb: {
                        busId: "1-2",
                        vendorId: "2341",
                        productId: "0043",
                        deviceClass: 2,
                        deviceSubclass: 0,
                        deviceProtocol: 0,
                        speed: "full",
                        port: 0,
                    },
                    port: null,
                    closeReason: null,
                    closedAt: null,
                },
            },
        });
        const bridge = bridgeOf(created);
        expect((await module.list(ctx, OWNER, project.id)).bridges).toEqual([bridge]);

        kernel.socket.write("CMD_SUBMIT");
        await vi.waitFor(() => {
            expect(webSocket.messages.at(-1)).toEqual(Buffer.from("CMD_SUBMIT"));
        });
        const fromClient = new Promise<string>((resolve) => {
            kernel.socket.once("data", (data: Buffer) => resolve(data.toString()));
        });
        webSocket.receive(Buffer.from("RET_SUBMIT"));
        await expect(fromClient).resolves.toBe("RET_SUBMIT");

        // The kernel ending its connection is the device detaching on that machine.
        kernel.socket.end();
        await vi.waitFor(() => {
            expect(webSocket.closedWith).toEqual({
                code: 1000,
                reason: "The USB device was detached from the workspace's machine.",
            });
        });
        expect(events[1]).toMatchObject({
            type: "bridge.updated",
            payload: {
                bridgeId: bridge.id,
                previousVersion: bridge.version,
                changes: { status: "closed", closeReason: { code: "device_detached" } },
            },
        });
        expect((await module.list(ctx, OWNER, project.id)).bridges).toEqual([]);
    });

    it("refuses an exporter that will not export the device or offers another one", async () => {
        const { controller, ctx, events, module, project } =
            await createWorld("bridges-usb-refused");

        const refused = open(await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }));
        refused.receive(usbImportReply({ busId: "1-2", status: 1 }).subarray(0, 8));
        const other = open(await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }));
        other.receive(usbImportReply({ busId: "1-3" }));

        expect(refused.closedWith?.code).toBe(4404);
        expect(other.closedWith?.code).toBe(4404);
        expect(controller.attached).toEqual([]);
        expect(events).toEqual([]);
    });

    it("closes on a malformed reply, a text message, and data before the kernel asked", async () => {
        const { ctx, module, project } = await createWorld("bridges-usb-protocol");
        const admit = async () =>
            open(await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }));

        const malformed = await admit();
        malformed.receive(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
        const text = await admit();
        text.receive("hello");
        const early = await admit();
        early.receive(Buffer.concat([usbImportReply({ busId: "1-2" }), Buffer.from("extra")]));

        for (const webSocket of [malformed, text, early]) {
            expect(webSocket.closedWith?.code).toBe(4400);
        }
    });

    it("gives up on an exporter that does not answer within ten seconds", async () => {
        const { ctx, module, project } = await createWorld("bridges-usb-timeout");
        const admission = await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const webSocket = open(admission);
        vi.advanceTimersByTime(9_999);
        expect(webSocket.closedWith).toBeUndefined();
        vi.advanceTimersByTime(1);

        expect(webSocket.closedWith?.code).toBe(4408);
    });

    it("reports a full controller and a refusing kernel with their own close codes", async () => {
        const { controller, ctx, events, module, project } =
            await createWorld("bridges-usb-kernel");

        controller.failure = new UsbAttachError("no_free_port", "No port.");
        const full = open(await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }));
        full.receive(usbImportReply({ busId: "1-2" }));
        await vi.waitFor(() => expect(full.closedWith?.code).toBe(4409));

        controller.failure = new Error("Invalid argument");
        const refused = open(await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }));
        refused.receive(usbImportReply({ busId: "1-2" }));
        await vi.waitFor(() => expect(refused.closedWith?.code).toBe(4502));
        expect(events).toEqual([]);
    });

    it("detaches when the client leaves, on request, on archival, and on shutdown", async () => {
        const { controller, ctx, events, module, project, workspace, workspaces } =
            await createWorld("bridges-usb-endings");
        const attach = async (workspaceId: string) => {
            const before = events.length;
            const webSocket = open(
                await module.admitUsb(ctx, OWNER, workspaceId, { busId: "1-2" }),
            );
            webSocket.receive(usbImportReply({ busId: "1-2" }));
            const bridge = await vi.waitFor(() =>
                bridgeOf(events.slice(before).find((event) => event.type === "bridge.created")),
            );
            return { bridge, kernel: controller.attached.at(-1)!.socket, webSocket };
        };

        const leaving = await attach(project.id);
        const kernelSawClose = new Promise<void>((resolve) => leaving.kernel.once("end", resolve));
        leaving.kernel.resume();
        leaving.webSocket.hangUp();
        await kernelSawClose;
        expect(lastUpdate(events)).toMatchObject({ closeReason: { code: "client_closed" } });

        const requested = await attach(project.id);
        const closed = module.closeBridge(OWNER, project.id, requested.bridge.id, "close-1");
        expect(closed).toMatchObject({
            status: "closed",
            closeReason: { code: "closed_by_request" },
        });
        expect(requested.webSocket.closedWith).toEqual({
            code: 1000,
            reason: "The bridge was closed on request.",
        });
        expect(events.at(-1)).toMatchObject({
            type: "bridge.updated",
            payload: { mutationId: "close-1", version: closed.version },
        });
        expect(() => module.closeBridge(OWNER, project.id, closed.id)).toThrow(
            expect.objectContaining({ code: "not_found" }),
        );

        const archived = await attach(workspace.id);
        await workspaces.beginArchive(ctx, workspace.id);
        await vi.waitFor(() => expect(archived.webSocket.closedWith?.code).toBe(1000));
        expect(lastUpdate(events)).toMatchObject({ closeReason: { code: "workspace_archived" } });

        const remaining = await attach(project.id);
        await module.close();
        expect(remaining.webSocket.closedWith?.code).toBe(1001);
        expect(lastUpdate(events)).toMatchObject({ closeReason: { code: "daemon_shutdown" } });
        await expect(
            module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }),
        ).rejects.toMatchObject({ code: "unavailable" });
    });

    it("refuses before the upgrade when USB is unavailable, full, or the ID is taken", async () => {
        const { controller, ctx, module, project } = await createWorld("bridges-usb-admission");

        const first = await module.admitUsb(ctx, OWNER, project.id, {
            busId: "1-2",
            id: "bridgeone",
        });
        await expect(
            module.admitUsb(ctx, OWNER, project.id, { busId: "1-3", id: "bridgeone" }),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(
            module.admitUsb(ctx, OWNER, project.id, { busId: "not a bus id" }),
        ).rejects.toMatchObject({ code: "invalid_request" });

        const admissions: BridgeAdmission[] = [first];
        while (admissions.length < MAX_USB_BRIDGES) {
            admissions.push(await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }));
        }
        await expect(
            module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }),
        ).rejects.toMatchObject({ code: "bridge_limit" });
        // An upgrade that never happened gives its place back.
        admissions.pop()?.failed();
        const replacement = await module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" });
        replacement.failed();
        for (const admission of admissions) admission.failed();

        const reason = { code: "vhci_missing", message: "No vhci-hcd here." };
        controller.machine = { usb: reason, bluetooth: reason };
        await expect(
            module.admitUsb(ctx, OWNER, project.id, { busId: "1-2" }),
        ).rejects.toMatchObject({ code: "bridge_unavailable", reason });
    });
});

describe("port bridges", () => {
    it("relays a connection on the workspace's machine to the client that accepts it", async () => {
        const { ctx, events, module, project } = await createWorld("bridges-port-open");

        const control = open(await module.admitPort(ctx, OWNER, project.id, { port: 0 }));
        const ready = JSON.parse(control.messages[0] as string) as {
            type: string;
            bridge: WorkspaceBridge;
        };
        expect(ready.type).toBe("ready");
        expect(ready.bridge).toEqual(bridgeOf(events[0]));
        const port = ready.bridge.port!.port;
        expect(ready.bridge).toMatchObject({
            kind: "port",
            name: `Port ${String(port)}`,
            port: { host: "127.0.0.1", port },
            usb: null,
        });

        const program = connect(port, "127.0.0.1");
        const connectionId = await control.nextConnection();
        expect(() =>
            module.admitConnection("someone-else", project.id, ready.bridge.id, connectionId),
        ).toThrow(expect.objectContaining({ code: "not_found" }));
        const carrier = open(
            module.admitConnection(OWNER, project.id, ready.bridge.id, connectionId),
        );
        expect(() =>
            module.admitConnection(OWNER, project.id, ready.bridge.id, connectionId),
        ).toThrow(expect.objectContaining({ code: "not_found" }));

        program.write("ping");
        await vi.waitFor(() => expect(carrier.messages).toEqual([Buffer.from("ping")]));
        const answer = new Promise<string>((resolve) => {
            program.once("data", (data: Buffer) => resolve(data.toString()));
        });
        carrier.receive(Buffer.from("pong"));
        await expect(answer).resolves.toBe("pong");

        program.end();
        await vi.waitFor(() => expect(carrier.closedWith?.code).toBe(1000));
        expect(control.closedWith).toBeUndefined();
    });

    it("declines a rejected connection and refuses a port already in use", async () => {
        const { ctx, module, project } = await createWorld("bridges-port-reject");
        const control = open(await module.admitPort(ctx, OWNER, project.id, { port: 0 }));
        const port = readyBridge(control).port!.port;

        const program = connect(port, "127.0.0.1");
        const programClosed = new Promise<void>((resolve) =>
            program.once("close", () => resolve()),
        );
        program.on("error", () => undefined);
        const connectionId = await control.nextConnection();
        control.receive(JSON.stringify({ type: "reject", connectionId }));
        await programClosed;

        const taken = await listening();
        try {
            await expect(
                module.admitPort(ctx, OWNER, project.id, { port: portOf(taken) }),
            ).rejects.toMatchObject({ code: "port_unavailable" });
        } finally {
            taken.close();
        }
    });

    it("ends the listener and every connection with the control WebSocket", async () => {
        const { ctx, events, module, project } = await createWorld("bridges-port-close");
        const control = open(await module.admitPort(ctx, OWNER, project.id, { port: 0 }));
        const bridge = readyBridge(control);
        const port = bridge.port!.port;
        const program = connect(port, "127.0.0.1");
        program.on("error", () => undefined);
        const carrier = open(
            module.admitConnection(OWNER, project.id, bridge.id, await control.nextConnection()),
        );

        control.hangUp();

        expect(carrier.closedWith?.code).toBe(1000);
        expect(lastUpdate(events)).toMatchObject({ closeReason: { code: "client_closed" } });
        const refused = await new Promise<string | undefined>((resolve) => {
            const late = connect(port, "127.0.0.1");
            late.once("connect", () => {
                late.destroy();
                resolve(undefined);
            });
            late.once("error", (error: NodeJS.ErrnoException) => resolve(error.code));
        });
        expect(refused).toBe("ECONNREFUSED");
    });

    it("closes the control WebSocket on anything but a known JSON message", async () => {
        const { ctx, module, project } = await createWorld("bridges-port-protocol");
        const admit = async () => open(await module.admitPort(ctx, OWNER, project.id, { port: 0 }));

        const binary = await admit();
        binary.receive(Buffer.from("{}"));
        const notJson = await admit();
        notJson.receive("reject");
        const unknown = await admit();
        unknown.receive(JSON.stringify({ type: "accept", connectionId: "abc" }));

        for (const webSocket of [binary, notJson, unknown]) {
            expect(webSocket.closedWith?.code).toBe(4400);
        }
    });

    it("keeps a bridge private to the person who opened it", async () => {
        const { ctx, module, project } = await createWorld("bridges-port-owner");
        const control = open(await module.admitPort(ctx, "alice", project.id, { port: 0 }));
        const bridge = readyBridge(control);

        expect((await module.list(ctx, "bob", project.id)).bridges).toEqual([]);
        expect((await module.list(ctx, "alice", project.id)).bridges).toEqual([bridge]);
        expect(() => module.closeBridge("bob", project.id, bridge.id)).toThrow(
            expect.objectContaining({ code: "not_found" }),
        );
    });
});

interface World {
    readonly archivedProject: { readonly id: string };
    readonly close: () => Promise<void>;
    readonly controller: FakeUsbHostController;
    readonly ctx: Context;
    readonly events: BridgeEvent[];
    readonly initializingWorkspace: { readonly id: string };
    readonly module: BridgesModule;
    readonly project: { readonly id: string };
    readonly projects: ProjectsModule;
    readonly workspace: { readonly id: string };
    readonly workspaces: WorkspacesModule;
}

async function createWorld(name: string): Promise<World> {
    const database = moduleDatabase([], name);
    for (const migrations of [durableFunctionsMigrations, projectMigrations, workspaceMigrations]) {
        for (const [, migrate] of migrations) await migrate(database.context, database.database);
    }
    const ctx = database.context;
    const config = await temporaryTestConfig();
    const { durableFunctions, projects, runners, start, workspaces } = workspacesCatalogFrom(
        config,
        new GitModule(),
    );
    await start(ctx);

    const project = await projects.create(ctx, { name: "Main", repositoryRef: "/projects/main" });
    const gone = await projects.create(ctx, { name: "Gone", repositoryRef: "/projects/gone" });
    const archivedProject = await projects.archive(ctx, gone.id);
    const reserved = await workspaces.reserve(ctx, { name: "Ready", projectRef: project.id });
    const workspace = await workspaces.markReady(ctx, { workspaceId: reserved.workspace.id });
    const initializing = await workspaces.reserve(ctx, {
        name: "Starting",
        projectRef: project.id,
    });

    const controller = new FakeUsbHostController();
    const module = BridgesModule.withUsbHostController(projects, workspaces, runners, controller);
    const events: BridgeEvent[] = [];
    module.onEvent((event) => events.push(event));
    const world: World = {
        archivedProject,
        close: async () => {
            durableFunctions.stop();
            await workspaces.close(ctx);
            database.close();
        },
        controller,
        ctx,
        events,
        initializingWorkspace: initializing.workspace,
        module,
        project,
        projects,
        workspace,
        workspaces,
    };
    opened.push(world);
    return world;
}

/** A kernel that takes every device, keeping its end of each connection for the test to drive. */
class FakeUsbHostController implements UsbHostController {
    machine: UsbMachineProbe = { usb: null, bluetooth: null };
    failure: Error | undefined;
    readonly attached: {
        readonly device: { readonly devid: number; readonly speed: number };
        readonly socket: Duplex;
    }[] = [];

    async probe(): Promise<UsbMachineProbe> {
        return structuredClone(this.machine);
    }

    async attach(_ctx: Context, device: { readonly devid: number; readonly speed: number }) {
        if (this.failure !== undefined) throw this.failure;
        const listener = await listening();
        const kernel = connect(portOf(listener), "127.0.0.1");
        let daemon: Socket;
        try {
            daemon = await new Promise<Socket>((resolve, reject) => {
                listener.once("connection", resolve);
                kernel.once("error", reject);
            });
        } finally {
            listener.close();
        }
        this.attached.push({
            device: { devid: device.devid, speed: device.speed },
            socket: kernel,
        });
        return { port: this.attached.length - 1, socket: daemon };
    }
}

/** The client's side of one bridge WebSocket, as the server would present it to a bridge. */
class FakeWebSocket implements BridgeWebSocket {
    readonly bufferedAmount = 0;
    readonly messages: (Buffer | string)[] = [];
    closedWith: { readonly code: number; readonly reason: string } | undefined;
    binding: BridgeWebSocketBinding | undefined;
    #seenConnections = 0;

    send(data: Uint8Array | string): void {
        if (this.closedWith !== undefined) return;
        this.messages.push(typeof data === "string" ? data : Buffer.from(data));
    }

    close(code: number, reason: string): void {
        if (this.closedWith !== undefined) return;
        this.closedWith = { code, reason };
        // A real server reports its own close back once the closing handshake ends.
        queueMicrotask(() => this.binding?.closed());
    }

    /** One message from the client. */
    receive(data: Uint8Array | string): void {
        this.binding?.message(data);
    }

    /** The client closes its WebSocket. */
    hangUp(): void {
        if (this.closedWith !== undefined) return;
        this.closedWith = { code: 1000, reason: "" };
        this.binding?.closed();
    }

    /** The next connection the control WebSocket announces. */
    async nextConnection(): Promise<string> {
        return await vi.waitFor(() => {
            const announced = this.messages
                .filter((message): message is string => typeof message === "string")
                .map((message) => JSON.parse(message) as { type: string; connectionId?: string })
                .filter((message) => message.type === "connection");
            const next = announced[this.#seenConnections];
            if (next?.connectionId === undefined) throw new Error("No connection announced yet.");
            this.#seenConnections += 1;
            return next.connectionId;
        });
    }
}

function open(admission: BridgeAdmission): FakeWebSocket {
    const webSocket = new FakeWebSocket();
    webSocket.binding = admission.attach(webSocket);
    return webSocket;
}

function readyBridge(control: FakeWebSocket): WorkspaceBridge {
    return (JSON.parse(control.messages[0] as string) as { bridge: WorkspaceBridge }).bridge;
}

function bridgeOf(event: BridgeEvent | undefined): WorkspaceBridge {
    if (event?.type !== "bridge.created") throw new Error("Not a created bridge.");
    return event.payload.bridge;
}

function lastUpdate(events: readonly BridgeEvent[]): unknown {
    const update = events.filter((event) => event.type === "bridge.updated").at(-1);
    return update?.type === "bridge.updated" ? update.payload.changes : undefined;
}

async function listening(): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
}

function portOf(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No port.");
    return address.port;
}
