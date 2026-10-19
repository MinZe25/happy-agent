import { describe, expect, it } from "vitest";
import {
    parseLinuxCpuTicks,
    parseLinuxDiskIo,
    parseLinuxMemory,
    parseLinuxMounts,
    parseLinuxProcess,
    parseLinuxGpu,
} from "../../../sources/surfaces/systemMonitor/parseLinux.js";
import {
    parseMacDiskIo,
    parseMacDisks,
    parseMacGpus,
    parseMacMemory,
    parseMacProcesses,
    parsePsTime,
} from "../../../sources/surfaces/systemMonitor/parseMac.js";
import {
    parseWindowsDisks,
    parseWindowsGpus,
    parseWindowsProcesses,
} from "../../../sources/surfaces/systemMonitor/parseWindows.js";
import { parseNvidia } from "../../../sources/surfaces/systemMonitor/parseNvidia.js";
import { processLeaders } from "../../../sources/surfaces/systemMonitor/parseProcess.js";
import type { SystemMonitorProcess } from "@slopus/happy-agent-client";

describe("Linux host telemetry output fixtures", () => {
    it("parses AMD busy/VRAM/hwmon counters while preserving unavailable Intel readings", () => {
        expect(
            parseLinuxGpu({
                vendorId: "0x1002\n",
                busy: "25\n",
                total: "8589934592\n",
                used: "268435456\n",
                temperature: "45000\n",
            }),
        ).toMatchObject({
            vendor: "amd",
            usagePercent: 25,
            memoryTotalBytes: 8589934592,
            memoryUsedBytes: 268435456,
            temperatureCelsius: 45,
        });
        expect(
            parseLinuxGpu({ vendorId: "0x8086", busy: "", total: "", used: "", temperature: "" }),
        ).toMatchObject({
            vendor: "intel",
            usagePercent: null,
            memoryTotalBytes: null,
            memoryUsedBytes: null,
            temperatureCelsius: null,
        });
    });
    it("uses MemAvailable rather than treating reclaimable cache as occupied memory", () => {
        expect(
            parseLinuxMemory(
                "MemTotal:       10000 kB\nMemFree: 1000 kB\nMemAvailable: 4000 kB\nCached: 2500 kB\nSReclaimable: 500 kB\nSwapTotal: 2000 kB\nSwapFree: 1500 kB\n",
            ),
        ).toEqual({
            totalBytes: 10240000,
            availableBytes: 4096000,
            usedBytes: 6144000,
            cachedBytes: 3072000,
            swapTotalBytes: 2048000,
            swapUsedBytes: 512000,
        });
        expect(parseLinuxMemory("MemTotal: 100 kB")).toBeNull();
    });
    it("finds stat fields after a comm containing spaces and parentheses, without reading arguments", () => {
        const process = parseLinuxProcess(
            "42 (worker ) name) R 1 42 42 0 -1 4194560 1 0 0 0 120 80 0 0 20 0 7 0 12345 4096000 250 18446744073709551615",
            "Name:\tworker ) name\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t4096 kB\n",
            100,
            1000000,
        );
        expect(process).toMatchObject({
            pid: 42,
            parentPid: 1,
            name: "worker ) name",
            user: "1000",
            state: "running",
            cpuTime: 200,
            memoryBytes: 4194304,
            threads: 7,
            startedAt: 1123450,
            startIdentity: "12345",
            cpuPercent: null,
        });
        expect(parseLinuxProcess("42 broken", "", 100, 0)).toBeNull();
        expect(parseLinuxProcess("42 (name) S 1", "", 100, 0)).toBeNull();
        expect(
            parseLinuxProcess(
                "42 (kworker/u18:2) I 1 42 42 0 -1 4194560 1 0 0 0 120 80 0 0 20 0 1 0 12345 0 0",
                "Uid:\t0\n",
                100,
                1000000,
            ),
        ).toMatchObject({ name: "kworker/u18:2", memoryBytes: 0 });
    });
    it("counts guest CPU only once and sums physical devices without partition double counting", () => {
        expect(parseLinuxCpuTicks("cpu 10 20 30 40 50 60 70 80 1000 2000\n")).toBe(360);
        const text =
            "259 0 nvme0n1 1 0 100 0 2 0 200 0 0 0 0\n259 1 nvme0n1p1 1 0 90 0 1 0 190 0 0 0 0\n253 0 dm-0 1 0 80 0 1 0 180 0 0 0 0";
        expect(parseLinuxDiskIo(text, new Set(["nvme0n1"]))).toEqual({
            read: 51200,
            write: 102400,
        });
        expect(parseLinuxDiskIo(text, new Set())).toBeNull();
    });
    it("unescapes mountinfo names and rejects virtual filesystems and snap images", () => {
        const mounts =
            "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /media/My\\040Disk rw - xfs /dev/sdb1 rw\n3 1 0:1 / /proc rw - proc proc rw\n4 1 0:2 / /tmp rw - tmpfs tmpfs rw\n5 1 7:0 / /snap/core ro - squashfs /dev/loop0 ro\n6 1 0:3 / /overlay rw - overlay overlay rw";
        expect(parseLinuxMounts(mounts)).toEqual([
            { mountPoint: "/", device: "/dev/sda1", fileSystem: "ext4" },
            { mountPoint: "/media/My Disk", device: "/dev/sdb1", fileSystem: "xfs" },
        ]);
    });
});

describe("macOS documented command output fixtures", () => {
    it("accounts anonymous, wired, compressed, and purgeable memory without adding cache to used", () => {
        const vm =
            "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 20.\nPages wired down: 10.\nAnonymous pages: 20.\nPages occupied by compressor: 5.\nPages purgeable: 2.\nFile-backed pages: 40.\n";
        expect(
            parseMacMemory(vm, 1048576, "total = 1024.00M used = 256.00M free = 768.00M"),
        ).toEqual({
            totalBytes: 1048576,
            usedBytes: 135168,
            availableBytes: 913408,
            cachedBytes: 163840,
            swapTotalBytes: 1073741824,
            swapUsedBytes: 268435456,
        });
        expect(parseMacMemory("invalid", 1000, "")).toBeNull();
    });
    it("parses cumulative ps CPU and strips executable paths while retaining spaces in names", () => {
        const rows = parseMacProcesses(
            " 501 1 501 S 4096 1:02.50 Mon Oct 19 12:00:00 2026 /Applications/My App.app/Contents/MacOS/My App\n 502 1 0 R 1024 12:34:56 Mon Oct 19 12:00:00 2026 /usr/bin/yes\n",
        );
        expect(rows[0]).toMatchObject({
            pid: 501,
            parentPid: 1,
            user: "501",
            state: "sleeping",
            memoryBytes: 4194304,
            cpuTime: 62500,
            name: "My App",
            threads: null,
            startIdentity: "Mon Oct 19 12:00:00 2026",
        });
        expect(rows[1]?.cpuTime).toBe(45296000);
        expect(parsePsTime("2-03:04:05.25")).toBe(183845250);
        expect(parsePsTime("not measured")).toBeNull();
    });
    it("parses df mount names with spaces and IOBlockStorageDriver byte counters", () => {
        expect(
            parseMacDisks(
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 1000 200 800 20% /Volumes/My Disk\ndevfs 100 50 50 50% /dev\n",
            ),
        ).toEqual([
            {
                device: "/dev/disk3s1",
                mountPoint: "/Volumes/My Disk",
                fileSystem: null,
                totalBytes: 1024000,
                usedBytes: 204800,
                availableBytes: 819200,
            },
        ]);
        expect(
            parseMacDiskIo(
                '"Statistics" = {"Bytes (Read)"=1000,"Bytes (Write)"=2000}\n"Statistics" = {"Bytes (Read)"=3000,"Bytes (Write)"=4000}',
            ),
        ).toEqual({ read: 4000, write: 6000 });
    });
    it("supports Apple and Intel accelerator utilization without requiring privileged powermetrics", () => {
        const apple =
            '+-o AGXAccelerator <class AGXAccelerator>\n "PerformanceStatistics" = {"Device Utilization %"=25,"In use system memory"=4096}\n';
        expect(parseMacGpus(apple, "Apple M2")).toEqual([
            {
                name: "Apple M2 GPU",
                vendor: "apple",
                usagePercent: 25,
                memoryTotalBytes: null,
                memoryUsedBytes: 4096,
                temperatureCelsius: null,
                powerWatts: null,
            },
        ]);
        expect(
            parseMacGpus(
                '+-o IntelAccelerator <class IOAccelerator>\n "PerformanceStatistics" = {"Device Utilization %"=0}',
                "Intel Core i9",
            )[0],
        ).toMatchObject({ vendor: "intel", usagePercent: 0 });
        expect(parseMacGpus("missing statistics", "Apple M2")).toEqual([]);
    });
});

describe("Windows selected CIM property fixtures", () => {
    it("converts 100ns CPU counters and rejects malformed data at the TypeBox boundary", () => {
        const rows = parseWindowsProcesses(
            JSON.stringify([
                {
                    ProcessId: 7,
                    ParentProcessId: 1,
                    Name: "C:\\Windows\\worker.exe",
                    WorkingSetSize: "4194304",
                    ThreadCount: 3,
                    KernelModeTime: "10000000",
                    UserModeTime: "20000000",
                    Started: "2026-10-19T12:00:00.000Z",
                },
            ]),
        );
        expect(rows?.[0]).toMatchObject({
            pid: 7,
            name: "worker.exe",
            cpuTime: 3000,
            memoryBytes: 4194304,
            threads: 3,
            startedAt: 1792411200000,
            state: null,
            user: null,
        });
        expect(parseWindowsProcesses("broken json")).toBeNull();
        expect(parseWindowsProcesses('[{"ProcessId":7}]')).toBeNull();
    });
    it("reads only local fixed volumes and avoids unreliable video-controller RAM counters", () => {
        expect(
            parseWindowsDisks(
                '[{"DeviceID":"C:","FileSystem":"NTFS","Size":"10000","FreeSpace":"4000"}]',
            ),
        ).toEqual([
            {
                device: "C:",
                mountPoint: "C:\\",
                fileSystem: "NTFS",
                totalBytes: 10000,
                availableBytes: 4000,
                usedBytes: 6000,
            },
        ]);
        expect(
            parseWindowsGpus(
                '[{"Name":"Intel Iris Xe","AdapterCompatibility":"Intel Corporation"}]',
            )[0],
        ).toMatchObject({ vendor: "intel", usagePercent: null, memoryTotalBytes: null });
    });
});

describe("GPU output and bounded process selection", () => {
    it("preserves missing nvidia-smi readings and converts MiB into bytes", () => {
        expect(
            parseNvidia(
                '"NVIDIA Device, Test", 12, 8192, 256, 45, 60.50\nOther GPU, [N/A], [Not Supported], N/A, N/A, N/A',
            )[0],
        ).toMatchObject({
            name: "NVIDIA Device, Test",
            usagePercent: 12,
            memoryTotalBytes: 8589934592,
            memoryUsedBytes: 268435456,
            temperatureCelsius: 45,
            powerWatts: 60.5,
        });
        expect(parseNvidia("Other GPU, N/A, N/A, N/A, N/A, N/A")[0]?.usagePercent).toBeNull();
    });
    it("retains both CPU leaders and idle memory leaders with no duplicates", () => {
        const items: SystemMonitorProcess[] = Array.from({ length: 120 }, (_, pid) => ({
            pid,
            parentPid: 1,
            name: `process ${pid}`,
            user: null,
            state: "sleeping",
            cpuPercent: pid < 60 ? pid : null,
            memoryBytes: pid * 1024,
            threads: 2,
            startedAt: 1,
        }));
        const result = processLeaders(items, 120);
        expect(result.items).toHaveLength(100);
        expect(result.items[0]?.pid).toBe(59);
        expect(result.items.some((p) => p.pid === 119)).toBe(true);
        expect(new Set(result.items.map((p) => p.pid)).size).toBe(100);
        expect(result.threads).toBe(240);
        expect(processLeaders(items, 121).threads).toBeNull();
    });
});
