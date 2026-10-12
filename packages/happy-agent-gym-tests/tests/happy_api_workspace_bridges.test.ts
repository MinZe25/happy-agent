import { connect, type Socket } from "node:net";

import {
    BridgeUpgradeError,
    connectBridgeWebSocket,
    createAgentGym,
    type AgentGym,
    type GymBridgeWebSocket,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type WorkspaceBridge = Awaited<
    ReturnType<AgentGym["client"]["listWorkspaceBridges"]>
>["bridges"][number];

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("local bridges through the public Happy Agent API", () => {
    it("advertises bridges, reports what the machine can take, and refuses USB it cannot attach", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const transport = { socketPath: gym.socketPath, token: gym.token };

        expect((await gym.client.getHealth()).capabilities?.workspaceBridges).toBe(true);
        const listed = await gym.client.listWorkspaceBridges(workspaceId);
        expect(listed).toMatchObject({
            bridges: [],
            cursor: expect.any(String),
            capabilities: {
                localToWorkspace: { available: true, reason: null },
                workspaceToLocal: { available: true, reason: null },
                bluetooth: { transport: "usb" },
            },
        });

        const usbUrl = gym.client.workspaceUsbBridgeUrl(workspaceId, { busId: "1-2" });
        if (!listed.capabilities.usb.available) {
            // This machine has no USB/IP controller the daemon may use: the refusal is a status
            // carrying the same reason the capability gave.
            const refusal = await connectBridgeWebSocket(usbUrl, transport).catch(
                (error: unknown) => error,
            );
            expect(refusal).toBeInstanceOf(BridgeUpgradeError);
            expect(refusal).toMatchObject({
                status: 409,
                body: { code: "bridge_unavailable", reason: listed.capabilities.usb.reason },
            });
        } else {
            // A machine that can attach still attaches nothing an exporter refuses to export.
            const usb = await connectBridgeWebSocket(usbUrl, transport);
            const request = await usb.next();
            expect(request.binary).toBe(true);
            expect(request.data.subarray(0, 4)).toEqual(Buffer.from([0x01, 0x11, 0x80, 0x03]));
            usb.send(Buffer.from([0x01, 0x11, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]));
            expect((await usb.closed).code).toBe(4404);
        }

        await expect(
            connectBridgeWebSocket(
                gym.client.workspaceUsbBridgeUrl(workspaceId, { busId: "not a bus" }),
                transport,
            ),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            connectBridgeWebSocket(
                gym.client.workspacePortBridgeUrl("missingworkspace", { port: 0 }),
                transport,
            ),
        ).rejects.toMatchObject({ status: 404 });
        expect(
            (await gym.http.get(`/v0/workspaces/${workspaceId}/bridges/port?port=0`)).status,
        ).toBe(400);
        await expect(
            gym.client.closeWorkspaceBridge(workspaceId, "missingbridge"),
        ).rejects.toMatchObject({ status: 404 });
    }, 30_000);

    it("forwards a port on the workspace's machine to the client that accepts each connection", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const transport = { socketPath: gym.socketPath, token: gym.token };

        const control = await connectBridgeWebSocket(
            gym.client.workspacePortBridgeUrl(workspaceId, { port: 0, name: "Database" }),
            transport,
        );
        const ready = await control.nextJson();
        expect(ready["type"]).toBe("ready");
        const bridge = ready["bridge"] as WorkspaceBridge;
        expect(bridge).toMatchObject({
            kind: "port",
            name: "Database",
            status: "open",
            workspaceId,
            port: { host: "127.0.0.1", port: expect.any(Number) },
            usb: null,
        });
        const created = await gym.waitForEvent(
            (event) => event.type === "bridge.created" && event.payload.bridge.id === bridge.id,
            "the bridge.created event",
        );
        expect(created.payload).toEqual({ bridge });
        expect((await gym.client.listWorkspaceBridges(workspaceId)).bridges).toEqual([bridge]);

        // A program on the workspace's machine connects; the client accepts and carries it.
        const program = connect(bridge.port!.port, "127.0.0.1");
        program.on("error", () => undefined);
        const connectionId = await nextConnection(control);
        const connectionUrl = gym.client.workspaceBridgeConnectionUrl(
            workspaceId,
            bridge.id,
            connectionId,
        );
        const carrier = await connectBridgeWebSocket(connectionUrl, transport);
        await expect(connectBridgeWebSocket(connectionUrl, transport)).rejects.toMatchObject({
            status: 404,
        });
        program.write("SELECT 1;");
        expect(await carrier.next()).toEqual({ binary: true, data: Buffer.from("SELECT 1;") });
        const answer = firstData(program);
        carrier.send(Buffer.from("1 row"));
        await expect(answer).resolves.toBe("1 row");

        // A connection the client declines is closed at once.
        const declined = connect(bridge.port!.port, "127.0.0.1");
        declined.on("error", () => undefined);
        const declinedClosed = new Promise<void>((resolve) =>
            declined.once("close", () => resolve()),
        );
        const declinedId = await nextConnection(control);
        control.send(JSON.stringify({ type: "reject", connectionId: declinedId }));
        await declinedClosed;

        const closed = await gym.client.closeWorkspaceBridge(workspaceId, bridge.id, {
            mutationId: "close-database",
        });
        expect(closed.bridge).toMatchObject({
            id: bridge.id,
            status: "closed",
            closeReason: { code: "closed_by_request" },
            closedAt: expect.any(Number),
        });
        expect(await control.closed).toEqual({
            code: 1000,
            reason: "The bridge was closed on request.",
        });
        expect((await carrier.closed).code).toBe(1000);
        const updated = await gym.waitForEvent(
            (event) => event.type === "bridge.updated" && event.payload.bridgeId === bridge.id,
            "the bridge.updated event",
        );
        expect(updated.payload).toMatchObject({
            previousVersion: bridge.version,
            version: closed.bridge.version,
            mutationId: "close-database",
            changes: { status: "closed", closeReason: { code: "closed_by_request" } },
        });
        expect((await gym.client.listWorkspaceBridges(workspaceId)).bridges).toEqual([]);
        program.destroy();
    }, 30_000);

    it("closes a workspace's bridges when the workspace is archived", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const root = await rootWorkspaceId(gym);
        const child = await readyChildWorkspace(gym, root);
        const transport = { socketPath: gym.socketPath, token: gym.token };

        const control = await connectBridgeWebSocket(
            gym.client.workspacePortBridgeUrl(child, { port: 0 }),
            transport,
        );
        const bridge = (await control.nextJson())["bridge"] as WorkspaceBridge;
        expect(bridge.name).toBe(`Port ${String(bridge.port!.port)}`);

        const current = (await gym.client.getWorkspace(child)).workspace;
        await gym.client.archiveWorkspace(child, { ifMatch: current.version });

        expect(await control.closed).toEqual({
            code: 1000,
            reason: "The workspace was archived.",
        });
        const updated = await gym.waitForEvent(
            (event) => event.type === "bridge.updated" && event.payload.bridgeId === bridge.id,
            "the bridge.updated event",
        );
        expect(updated.payload).toMatchObject({
            changes: { status: "closed", closeReason: { code: "workspace_archived" } },
        });
        expect(updated.payload).not.toHaveProperty("mutationId");
    }, 30_000);
});

/** The next connection a port bridge's control WebSocket announces. */
async function nextConnection(control: GymBridgeWebSocket): Promise<string> {
    const message = await control.nextJson();
    expect(message["type"]).toBe("connection");
    return message["connectionId"] as string;
}

function firstData(socket: Socket): Promise<string> {
    return new Promise((resolve) => {
        socket.once("data", (data: Buffer) => resolve(data.toString()));
    });
}

async function rootWorkspaceId(gym: AgentGym): Promise<string> {
    const project = await gym.waitUntil(
        async () => {
            const projects = await gym.client.listProjects();
            const candidate = projects.projects.find((project) => project.status === "active");
            return candidate?.initialization.status === "ready" ? candidate : undefined;
        },
        "the root project to become ready",
        15_000,
    );
    return project.id;
}

async function readyChildWorkspace(gym: AgentGym, parentId: string): Promise<string> {
    const created = await gym.client.createWorkspace({ name: "gym-bridge-child", parentId });
    return await gym.waitUntil(
        async () => {
            const current = await gym.client.getWorkspace(created.workspace.id);
            if (current.workspace.initialization.status === "failed") {
                throw new Error("The child workspace failed to initialize.");
            }
            return current.workspace.initialization.status === "ready"
                ? current.workspace.id
                : undefined;
        },
        "the child workspace to become ready",
        15_000,
    );
}
