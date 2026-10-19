import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { SystemMonitorSampler } from "../../../sources/surfaces/systemMonitor/SystemMonitorSampler.js";
import { HostProbes } from "../../../sources/surfaces/systemMonitor/HostProbes.js";
import type { RawProcess } from "../../../sources/surfaces/systemMonitor/parseProcess.js";

const running: AbortController[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(globalThis.process, "platform")!;
const process: RawProcess = {
    pid: 42,
    parentPid: 1,
    name: "worker",
    user: "1000",
    state: "running",
    cpuPercent: null,
    memoryBytes: 1024,
    threads: 2,
    startedAt: 1,
    startIdentity: "start1",
    cpuTime: 0,
};

function start(): SystemMonitorSampler {
    const controller = new AbortController();
    running.push(controller);
    return new SystemMonitorSampler(
        withLifetime(createRootContext().named("test-daemon"), controller.signal),
    );
}
beforeEach(() => {
    // The controlled probe fixtures use Linux tick units; other OS formats have their own parser fixtures.
    Object.defineProperty(globalThis.process, "platform", {
        ...platformDescriptor,
        value: "linux",
    });
    vi.useFakeTimers();
    let ticks = 0;
    vi.spyOn(os, "cpus").mockImplementation(() => [
        {
            model: "Fixture CPU",
            speed: 3000,
            times: { user: ++ticks * 20, idle: ticks * 80, nice: 0, irq: 0, sys: 0 },
        },
    ]);
    vi.spyOn(HostProbes.prototype, "memory").mockResolvedValue({
        totalBytes: 100,
        usedBytes: 40,
        availableBytes: 60,
        cachedBytes: 30,
        swapTotalBytes: 0,
        swapUsedBytes: 0,
    });
    vi.spyOn(HostProbes.prototype, "gpus").mockResolvedValue([]);
    vi.spyOn(HostProbes.prototype, "disks").mockResolvedValue([]);
    vi.spyOn(HostProbes.prototype, "osName").mockResolvedValue("Fixture Linux");
    vi.spyOn(HostProbes.prototype, "cpuTemperature").mockResolvedValue(null);
    vi.spyOn(HostProbes.prototype, "diskIo").mockResolvedValue(null);
    vi.spyOn(HostProbes.prototype, "processes").mockResolvedValue({
        total: 1,
        items: [process],
        capacity: 100,
    });
});
afterEach(() => {
    for (const controller of running.splice(0)) controller.abort();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis.process, "platform", platformDescriptor);
});

describe("daemon-wide telemetry sampling", () => {
    it("returns a valid snapshot with native memory fallback when optional probes fail", async () => {
        vi.spyOn(os, "totalmem").mockReturnValue(100);
        vi.spyOn(os, "freemem").mockReturnValue(60);
        vi.mocked(HostProbes.prototype.memory).mockRejectedValue(new Error("unavailable"));
        vi.mocked(HostProbes.prototype.gpus).mockRejectedValue(new Error("unavailable"));
        vi.mocked(HostProbes.prototype.disks).mockRejectedValue(new Error("unavailable"));
        vi.mocked(HostProbes.prototype.processes).mockRejectedValue(new Error("unavailable"));
        const sampler = start(),
            first = sampler.read();
        await vi.advanceTimersByTimeAsync(1000);
        const snapshot = await first;
        expect(snapshot.memory).toEqual({
            totalBytes: 100,
            usedBytes: 40,
            availableBytes: 60,
            cachedBytes: null,
            swapTotalBytes: null,
            swapUsedBytes: null,
        });
        expect(snapshot.gpus).toEqual([]);
        expect(snapshot.disks).toEqual([]);
        expect(snapshot.processes).toBeNull();
    });
    it("shares concurrent initial reads and needs two CPU observations without fabricating load", async () => {
        const sampler = start();
        const a = sampler.read(),
            b = sampler.read();
        await vi.advanceTimersByTimeAsync(1000);
        const [one, two] = await Promise.all([a, b]);
        expect(one).toBe(two);
        expect(one.cpu.usagePercent).toBeCloseTo(20);
        expect(one.history[0]?.cpuPercent).toBeNull();
        expect(one.memory).toMatchObject({ usedBytes: 40, availableBytes: 60 });
        expect(HostProbes.prototype.processes).toHaveBeenCalledTimes(2);
    });
    it("keeps sampling other metrics when a process scan never settles, with only one scan outstanding", async () => {
        vi.mocked(HostProbes.prototype.processes).mockImplementation(() => new Promise(() => {}));
        const sampler = start(),
            first = sampler.read();
        await vi.advanceTimersByTimeAsync(1500);
        expect((await first).processes).toBeNull();
        await vi.advanceTimersByTimeAsync(9000);
        const snapshot = await sampler.read();
        expect(snapshot.history.length).toBeGreaterThan(8);
        expect(snapshot.cpu.usagePercent).toBeCloseTo(20);
        expect(HostProbes.prototype.processes).toHaveBeenCalledTimes(1);
        expect(HostProbes.prototype.memory).toHaveBeenCalledTimes(11);
    });
    it("measures process CPU on whole-machine capacity, resets reused PIDs, and prunes departed processes", async () => {
        const probe = vi.mocked(HostProbes.prototype.processes);
        probe.mockResolvedValueOnce({
            total: 1,
            items: [{ ...process, cpuTime: 10 }],
            capacity: 100,
        });
        probe.mockResolvedValueOnce({
            total: 1,
            items: [{ ...process, cpuTime: 30 }],
            capacity: 200,
        });
        probe.mockResolvedValueOnce({
            total: 1,
            items: [{ ...process, startIdentity: "new", cpuTime: 40 }],
            capacity: 300,
        });
        probe.mockResolvedValue({ total: 0, items: [], capacity: 400 });
        const sampler = start(),
            first = sampler.read();
        await vi.advanceTimersByTimeAsync(1000);
        await first;
        await vi.advanceTimersByTimeAsync(1000);
        expect((await sampler.read()).processes?.items[0]?.cpuPercent).toBe(20);
        await vi.advanceTimersByTimeAsync(1000);
        expect((await sampler.read()).processes?.items[0]?.cpuPercent).toBeNull();
        await vi.advanceTimersByTimeAsync(1000);
        expect((await sampler.read()).processes?.items).toEqual([]);
    });
    it("bounds history, stops after no reads, resumes with a fresh baseline, and shuts down cleanly", async () => {
        const sampler = start(),
            first = sampler.read();
        await vi.advanceTimersByTimeAsync(1000);
        await first;
        for (let i = 0; i < 310; i++) {
            await sampler.read();
            await vi.advanceTimersByTimeAsync(1000);
        }
        const snapshot = await sampler.read();
        expect(snapshot.history).toHaveLength(300);
        expect(snapshot.history.map((point) => point.sampledAt)).toEqual(
            snapshot.history.map((point) => point.sampledAt).sort((a, b) => a - b),
        );
        await vi.advanceTimersByTimeAsync(61000);
        const calls = vi.mocked(HostProbes.prototype.memory).mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(HostProbes.prototype.memory).toHaveBeenCalledTimes(calls);
        const resumed = sampler.read();
        await vi.advanceTimersByTimeAsync(1000);
        expect((await resumed).cpu.usagePercent).toBeCloseTo(20);
        running[0]!.abort();
        await vi.advanceTimersByTimeAsync(2000);
        expect(vi.getTimerCount()).toBe(0);
    });
});
