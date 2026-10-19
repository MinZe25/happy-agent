import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    createSurfaceRequestSchema,
    systemMonitorSnapshotSchema,
    systemMonitorProcessesSchema,
    type SystemMonitorSnapshot,
} from "../sources/protocol/surfaces.js";

const snapshot: SystemMonitorSnapshot = {
    sampledAt: 1760943600000,
    intervalMs: 1000,
    host: { hostname: "box", platform: "linux", arch: "x64", osName: "Linux", uptimeSeconds: 10 },
    cpu: {
        model: "CPU",
        logicalCores: 2,
        usagePercent: null,
        perCoreUsagePercent: null,
        loadAverage: null,
        speedMhz: null,
        temperatureCelsius: null,
    },
    memory: {
        totalBytes: 100,
        usedBytes: 40,
        availableBytes: 60,
        cachedBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
    },
    gpus: [],
    disks: [],
    diskIo: null,
    processes: null,
    history: [],
};

describe("System Monitor protocol", () => {
    it("accepts an additive typed creation without host configuration", () => {
        expect(
            Value.Check(createSurfaceRequestSchema, {
                type: "system_monitor",
                name: "System Monitor",
            }),
        ).toBe(true);
        expect(
            Value.Check(createSurfaceRequestSchema, {
                type: "system_monitor",
                name: "Monitor",
                host: "remote",
            }),
        ).toBe(false);
    });
    it("accepts unavailable initial measurements and enforces numeric bounds", () => {
        expect(Value.Check(systemMonitorSnapshotSchema, snapshot)).toBe(true);
        expect(
            Value.Check(systemMonitorSnapshotSchema, {
                ...snapshot,
                cpu: { ...snapshot.cpu, usagePercent: 101 },
            }),
        ).toBe(false);
        expect(
            Value.Check(systemMonitorSnapshotSchema, {
                ...snapshot,
                memory: { ...snapshot.memory, usedBytes: -1 },
            }),
        ).toBe(false);
        expect(
            Value.Check(systemMonitorSnapshotSchema, {
                ...snapshot,
                cpu: { ...snapshot.cpu, loadAverage: [1, 2] },
            }),
        ).toBe(false);
    });
    it("bounds process lists and accepts unknown initial CPU without inventing zero", () => {
        const process = {
            pid: 42,
            parentPid: 1,
            name: "node",
            user: null,
            state: "running",
            cpuPercent: null,
            memoryBytes: 1024,
            threads: 1,
            startedAt: null,
        };
        expect(
            Value.Check(systemMonitorProcessesSchema, { total: 1, threads: 1, items: [process] }),
        ).toBe(true);
        expect(
            Value.Check(systemMonitorProcessesSchema, {
                total: 101,
                threads: null,
                items: Array.from({ length: 101 }, (_, pid) => ({ ...process, pid })),
            }),
        ).toBe(false);
        for (const invalid of [
            { ...process, cpuPercent: 101 },
            { ...process, memoryBytes: null },
            { ...process, state: "R" },
        ]) {
            expect(
                Value.Check(systemMonitorProcessesSchema, {
                    total: 1,
                    threads: null,
                    items: [invalid],
                }),
            ).toBe(false);
        }
    });
    it("reads the direct snapshot with an encoded Surface ID and abort signal", async () => {
        const signal = new AbortController().signal;
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                expect(input.toString()).toBe(
                    "http://agent.local/v0/surfaces/system-monitor/surface%2Fid",
                );
                expect(init?.method).toBe("GET");
                expect(init?.signal).toBe(signal);
                return new Response(JSON.stringify(snapshot));
            },
        });
        expect(await client.getSystemMonitor("surface/id", { signal })).toEqual(snapshot);
    });
});
