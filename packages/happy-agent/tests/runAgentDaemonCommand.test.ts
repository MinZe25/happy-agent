import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    stop: vi.fn(),
    ensure: vi.fn(),
    pid: vi.fn(),
}));

vi.mock("@slopus/happy-agent-client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@slopus/happy-agent-client")>()),
    HappyAgentClient: class {
        getHealth = async () => ({ healthy: true, ready: true });
    },
}));
vi.mock("../sources/lifecycle/daemonToken.js", () => ({
    readDaemonTokenIfPresent: async () => "test-token",
}));
vi.mock("../sources/lifecycle/daemonPid.js", () => ({
    readDaemonPid: mocks.pid,
}));
vi.mock("../sources/lifecycle/stopLocalProtocolServer.js", () => ({
    stopLocalProtocolServer: mocks.stop,
}));
vi.mock("../sources/lifecycle/ensureAgentDaemon.js", () => ({
    ensureAgentDaemon: mocks.ensure,
}));

let happyHome: string;

beforeEach(async () => {
    vi.clearAllMocks();
    mocks.stop.mockReset();
    mocks.ensure.mockResolvedValue({ paths: { socketPath: "/test/server.sock" } });
    // A reload reports itself under the Happy home; never the real one.
    happyHome = await mkdtemp(join(tmpdir(), "reload-command-"));
    vi.stubEnv("HAPPY_HOME_DIR", happyHome);
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(happyHome, { force: true, recursive: true });
});

async function reloadStatus(): Promise<unknown> {
    return JSON.parse(await readFile(join(happyHome, "agent", "reload.json"), "utf8"));
}

it("rejects a reload owned by the daemon before draining or stopping it", async () => {
    const { runAgentDaemonCommand } = await import("../sources/lifecycle/runAgentDaemonCommand.js");
    mocks.pid.mockResolvedValue(process.ppid);

    await expect(runAgentDaemonCommand("reload", { log: () => undefined })).rejects.toMatchObject({
        message: "Cannot reload Happy Agent from a process owned by that daemon.",
        hint: "Run happy-agent reload --detach, which reloads after the calling command exits.",
    });

    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    // A refused reload never started, so no client is told one is under way.
    await expect(reloadStatus()).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps an external reload synchronous through replacement startup", async () => {
    const { runAgentDaemonCommand } = await import("../sources/lifecycle/runAgentDaemonCommand.js");
    mocks.pid.mockResolvedValue(2_147_483_647);

    await runAgentDaemonCommand("reload", { log: () => undefined });

    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.ensure.mock.invocationCallOrder[0]!,
    );
    expect(await reloadStatus()).toMatchObject({ format: 1, phase: "done", pid: process.pid });
});

it("reports the drain, stop, and start phases a reload passes through", async () => {
    const { runAgentDaemonCommand } = await import("../sources/lifecycle/runAgentDaemonCommand.js");
    mocks.pid.mockResolvedValue(2_147_483_647);
    const seen: unknown[] = [];
    mocks.stop.mockImplementation(async (_client, _paths, options) => {
        options.onDrainWaiting([
            { count: 1, name: "agent-system", agents: [{ id: "a", stage: "tools" }] },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen.push(await reloadStatus());
        options.onStopping();
    });
    mocks.ensure.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen.push(await reloadStatus());
        return { paths: { socketPath: "/test/server.sock" } };
    });
    const diagnostics: string[] = [];

    await runAgentDaemonCommand("reload", {
        diagnostics: (line) => diagnostics.push(line),
        log: () => undefined,
    });

    expect(seen).toMatchObject([
        { phase: "draining", waitingFor: [{ count: 1, name: "agent-system" }], waitingPeak: 1 },
        { phase: "starting" },
    ]);
    const done = (await reloadStatus()) as { operationId: string; startedAt: number };
    expect(done).toMatchObject({
        phase: "done",
        operationId: (seen[0] as { operationId: string }).operationId,
    });
    expect(diagnostics.map((line) => line.split(" ")[1])).toEqual([
        "phase=draining",
        "phase=stopping",
        "phase=starting",
        "phase=done",
        "durationMs=" + diagnostics.at(-1)!.split("durationMs=")[1],
    ]);
});

it("reports where a reload failed", async () => {
    const { runAgentDaemonCommand } = await import("../sources/lifecycle/runAgentDaemonCommand.js");
    mocks.pid.mockResolvedValue(2_147_483_647);
    mocks.ensure.mockRejectedValue(new Error("The local daemon could not be started."));

    await expect(runAgentDaemonCommand("reload", { log: () => undefined })).rejects.toThrow(
        "The local daemon could not be started.",
    );

    expect(await reloadStatus()).toMatchObject({
        failedAt: "starting",
        message: "The local daemon could not be started.",
        phase: "failed",
    });
});
