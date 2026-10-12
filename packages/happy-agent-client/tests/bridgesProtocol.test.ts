import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    WORKSPACE_BRIDGE_CLOSE_CODES,
    healthResponseSchema,
    workspaceBridgeCapabilitiesSchema,
    workspaceBridgeChangesSchema,
    workspaceBridgeListResponseSchema,
    workspaceBridgeSchema,
    workspaceBridgeUpdatedPayloadSchema,
    workspacePortBridgeClientMessageSchema,
    workspacePortBridgeQuerySchema,
    workspacePortBridgeServerMessageSchema,
    workspaceUsbBridgeQuerySchema,
    type HappyAgentEvent,
    type WorkspaceBridge,
    type WorkspaceBridgeCapabilities,
} from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const usbBridge: WorkspaceBridge = {
    id: "bridge1",
    workspaceId: "workspace1",
    kind: "usb",
    name: "Arduino Uno",
    status: "open",
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
    version,
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
};
const portBridge: WorkspaceBridge = {
    ...usbBridge,
    id: "bridge2",
    kind: "port",
    name: "Port 5432",
    usb: null,
    port: { host: "127.0.0.1", port: 5432 },
};
const capabilities: WorkspaceBridgeCapabilities = {
    usb: {
        available: false,
        reason: { code: "vhci_not_loaded", message: "Load the vhci-hcd kernel module." },
    },
    bluetooth: {
        available: false,
        transport: "usb",
        reason: { code: "vhci_not_loaded", message: "Load the vhci-hcd kernel module." },
    },
    localToWorkspace: { available: true, reason: null },
    workspaceToLocal: { available: true, reason: null },
};

describe("workspace bridges protocol", () => {
    it("models USB and port bridges and their capabilities", () => {
        expect(Value.Check(workspaceBridgeSchema, usbBridge)).toBe(true);
        expect(Value.Check(workspaceBridgeSchema, portBridge)).toBe(true);
        expect(Value.Check(workspaceBridgeSchema, { ...usbBridge, futureField: 1 })).toBe(true);
        expect(
            Value.Check(workspaceBridgeSchema, {
                ...usbBridge,
                status: "closed",
                closeReason: { code: "device_detached", message: "The device was detached." },
                closedAt: 2,
            }),
        ).toBe(true);
        for (const invalid of [
            { kind: "serial" },
            { status: "opening" },
            { name: "" },
            { name: "x".repeat(129) },
            { usb: { ...usbBridge.usb, vendorId: "2341A" } },
            { usb: { ...usbBridge.usb, vendorId: "ABCD" } },
            { usb: { ...usbBridge.usb, speed: "turbo" } },
            { usb: { ...usbBridge.usb, deviceClass: 256 } },
        ])
            expect(Value.Check(workspaceBridgeSchema, { ...usbBridge, ...invalid })).toBe(false);
        expect(
            Value.Check(workspaceBridgeSchema, { ...portBridge, port: { host: "::1", port: 0 } }),
        ).toBe(false);
        expect(Value.Check(workspaceBridgeCapabilitiesSchema, capabilities)).toBe(true);
        expect(
            Value.Check(workspaceBridgeCapabilitiesSchema, {
                ...capabilities,
                bluetooth: { available: true, reason: null },
            }),
        ).toBe(false);
        expect(
            Value.Check(workspaceBridgeListResponseSchema, {
                capabilities,
                bridges: [usbBridge, portBridge],
                cursor: version,
            }),
        ).toBe(true);
        expect(
            Value.Check(healthResponseSchema, {
                capabilities: { workspaceBridges: true },
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 26, daemon: "1.2.3" },
            }),
        ).toBe(true);
    });

    it("bounds WebSocket queries and control messages", () => {
        expect(Value.Check(workspaceUsbBridgeQuerySchema, { busId: "1-2.3" })).toBe(true);
        expect(
            Value.Check(workspaceUsbBridgeQuerySchema, {
                busId: "usb:20-1",
                id: "bridge1",
                name: "Keyboard",
            }),
        ).toBe(true);
        for (const busId of ["", "x".repeat(32), "1 2", "1/2"])
            expect(Value.Check(workspaceUsbBridgeQuerySchema, { busId })).toBe(false);
        expect(Value.Check(workspacePortBridgeQuerySchema, { port: 0 })).toBe(true);
        expect(Value.Check(workspacePortBridgeQuerySchema, { port: 65535 })).toBe(true);
        expect(Value.Check(workspacePortBridgeQuerySchema, { port: 65536 })).toBe(false);
        expect(Value.Check(workspacePortBridgeQuerySchema, { port: -1 })).toBe(false);
        expect(
            Value.Check(workspacePortBridgeServerMessageSchema, {
                type: "ready",
                bridge: portBridge,
            }),
        ).toBe(true);
        expect(
            Value.Check(workspacePortBridgeServerMessageSchema, {
                type: "connection",
                connectionId: "connection1",
            }),
        ).toBe(true);
        expect(Value.Check(workspacePortBridgeServerMessageSchema, { type: "connection" })).toBe(
            false,
        );
        expect(
            Value.Check(workspacePortBridgeClientMessageSchema, {
                type: "reject",
                connectionId: "connection1",
            }),
        ).toBe(true);
        expect(
            Value.Check(workspacePortBridgeClientMessageSchema, {
                type: "accept",
                connectionId: "connection1",
            }),
        ).toBe(false);
        expect(WORKSPACE_BRIDGE_CLOSE_CODES).toMatchObject({
            normal: 1000,
            shutdown: 1001,
            internal: 1011,
            protocolViolation: 4400,
            deviceRefused: 4404,
            importTimeout: 4408,
            noFreePort: 4409,
            kernelRefused: 4502,
        });
    });

    it("chains closing updates by version", () => {
        const changes = {
            status: "closed",
            closeReason: { code: "closed_by_request", message: "The bridge was closed." },
            closedAt: 3,
            updatedAt: 3,
        };
        expect(Value.Check(workspaceBridgeChangesSchema, changes)).toBe(true);
        expect(Value.Check(workspaceBridgeChangesSchema, { status: "closed" })).toBe(false);
        expect(
            Value.Check(workspaceBridgeUpdatedPayloadSchema, {
                bridgeId: usbBridge.id,
                workspaceId: usbBridge.workspaceId,
                previousVersion: version,
                version: nextVersion,
                changes,
                mutationId: "mutation1",
            }),
        ).toBe(true);
        const events: HappyAgentEvent[] = [
            {
                cursor: version,
                type: "bridge.created",
                occurredAt: 1,
                payload: { bridge: usbBridge },
            },
            {
                cursor: nextVersion,
                type: "bridges.capabilities.updated",
                occurredAt: 2,
                payload: {},
            },
        ];
        expect(events.map((event) => event.type)).toEqual([
            "bridge.created",
            "bridges.capabilities.updated",
        ]);
    });

    it("addresses every bridge route beneath the workspace, including through a connection", async () => {
        const calls: { url: URL; init: RequestInit | undefined }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=key",
            token: "daemon-credential",
            fetch: async (input, init) => {
                const url = new URL(input.toString());
                calls.push({ url, init });
                if (init?.method === "DELETE")
                    return Response.json({
                        bridge: { ...usbBridge, status: "closed", closedAt: 2 },
                    });
                return Response.json({ capabilities, bridges: [usbBridge], cursor: version });
            },
        });
        const remote = client.connection("build-box");

        await expect(remote.listWorkspaceBridges("workspace1")).resolves.toMatchObject({
            bridges: [{ id: "bridge1" }],
        });
        await expect(
            remote.closeWorkspaceBridge("workspace1", "bridge1", { mutationId: "mutation1" }),
        ).resolves.toMatchObject({ bridge: { status: "closed" } });
        expect(calls.map(({ url, init }) => `${init?.method} ${url.pathname}`)).toEqual([
            "GET /prefix/v0/connections/build-box/api/v0/workspaces/workspace1/bridges",
            "DELETE /prefix/v0/connections/build-box/api/v0/workspaces/workspace1/bridges/bridge1",
        ]);
        expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ mutationId: "mutation1" });
        expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
            "Bearer daemon-credential",
        );

        const usb = new URL(
            client.workspaceUsbBridgeUrl("workspace1", { busId: "1-2", name: "Arduino Uno" }),
        );
        expect(usb.pathname).toBe("/prefix/v0/workspaces/workspace1/bridges/usb");
        expect(Object.fromEntries(usb.searchParams)).toEqual({
            busId: "1-2",
            name: "Arduino Uno",
            transport: "key",
        });
        const port = new URL(
            remote.workspacePortBridgeUrl("workspace1", { port: 5432, id: "bridge2" }),
        );
        expect(port.pathname).toBe(
            "/prefix/v0/connections/build-box/api/v0/workspaces/workspace1/bridges/port",
        );
        expect(port.searchParams.get("port")).toBe("5432");
        expect(port.searchParams.get("id")).toBe("bridge2");
        expect(
            new URL(remote.workspaceBridgeConnectionUrl("workspace1", "bridge2", "connection1"))
                .pathname,
        ).toBe(
            "/prefix/v0/connections/build-box/api/v0/workspaces/workspace1/bridges/bridge2/connections/connection1",
        );
    });
});
