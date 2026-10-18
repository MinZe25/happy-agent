import { createRootContext } from "@steve.kite/stdlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    bindAgentHttpServer: vi.fn(),
    bindAgentSocket: vi.fn(),
    removeInactiveAgentSocket: vi.fn(),
    removeDaemonPid: vi.fn(),
    startHappyAgentRuntime: vi.fn(),
    writeDaemonPid: vi.fn(),
}));

vi.mock("@slopus/happy-agent-modules", () => ({
    startHappyAgentRuntime: mocks.startHappyAgentRuntime,
}));
vi.mock("../sources/lifecycle/daemonPid.js", () => ({
    removeDaemonPid: mocks.removeDaemonPid,
    writeDaemonPid: mocks.writeDaemonPid,
}));
vi.mock("../sources/socket/AgentSocket.js", () => ({
    bindAgentHttpServer: mocks.bindAgentHttpServer,
    bindAgentSocket: mocks.bindAgentSocket,
    removeInactiveAgentSocket: mocks.removeInactiveAgentSocket,
}));
import { startHappyAgentDaemon } from "../sources/main.js";

const closeMobile = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
});

/** Bind the main HTTP listener to `closeHttp`, and the mobile connector's loopback listener apart from it. */
function arrangeHttp(closeHttp: ReturnType<typeof vi.fn>): void {
    mocks.bindAgentHttpServer.mockImplementation(
        async (_prepared: unknown, host: string, port: number) =>
            port === 0
                ? { close: closeMobile, host, port: 45_678, url: "http://127.0.0.1:45678" }
                : { close: closeHttp, host, port, url: `http://${host}:${port}` },
    );
}

describe("startHappyAgentDaemon", () => {
    it("uses the API drain barrier without shutting down either transport", async () => {
        const runtime = arrangeRuntime(true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);
        const daemon = await startHappyAgentDaemon();
        daemon.drain();
        expect(runtime.beginDrain).toHaveBeenCalledOnce();
        expect(daemon.drainProgress()).toEqual([{ name: "agent-system", count: 1 }]);
        expect(runtime.shutdown).not.toHaveBeenCalled();
        expect(closeHttp).not.toHaveBeenCalled();
        await daemon.close();
    });
    it("binds TCP HTTP instead of the local socket in team mode", async () => {
        const runtime = arrangeRuntime(true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);

        const daemon = await startHappyAgentDaemon();

        expect(mocks.removeInactiveAgentSocket).toHaveBeenCalledWith("/tmp/happy-team/server.sock");
        expect(mocks.bindAgentSocket).not.toHaveBeenCalled();
        expect(mocks.bindAgentHttpServer).toHaveBeenCalledWith(
            expect.anything(),
            "127.0.0.1",
            3_000,
        );
        expect(daemon.httpUrl).toBe("http://127.0.0.1:3000");
        expect(daemon.socketPath).toBe("/tmp/happy-team/server.sock");
        await daemon.close();
        expect(closeHttp).toHaveBeenCalledOnce();
        expect(runtime.shutdown).toHaveBeenCalledOnce();
        expect(runtime.close).toHaveBeenCalledOnce();
    });

    it("continues to bind and close the local socket in standalone mode", async () => {
        const runtime = arrangeRuntime(false);
        const closeSocket = vi.fn();
        mocks.bindAgentSocket.mockResolvedValue({
            close: closeSocket,
            socketPath: "/tmp/happy-team/server.sock",
        });

        const daemon = await startHappyAgentDaemon();

        expect(mocks.bindAgentSocket).toHaveBeenCalledOnce();
        expect(mocks.bindAgentHttpServer).toHaveBeenCalledOnce();
        expect(mocks.removeInactiveAgentSocket).not.toHaveBeenCalled();
        await daemon.close();
        expect(closeSocket).toHaveBeenCalledOnce();
        expect(runtime.close).toHaveBeenCalledOnce();
    });

    it("serves phones on their own loopback listener and closes it before the main transport", async () => {
        const runtime = arrangeRuntime(true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);

        const daemon = await startHappyAgentDaemon();

        expect(mocks.bindAgentHttpServer).toHaveBeenCalledTimes(2);
        expect(mocks.bindAgentHttpServer).toHaveBeenLastCalledWith(
            expect.anything(),
            "127.0.0.1",
            0,
        );
        expect(runtime.attachMobileTransport).toHaveBeenCalledWith(expect.anything(), {
            host: "127.0.0.1",
            port: 45_678,
        });
        expect(daemon.httpUrl).toBe("http://127.0.0.1:3000");

        await daemon.close();
        expect(closeMobile).toHaveBeenCalledOnce();
        expect(runtime.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
            closeMobile.mock.invocationCallOrder[0]!,
        );
        expect(closeMobile.mock.invocationCallOrder[0]).toBeLessThan(
            closeHttp.mock.invocationCallOrder[0]!,
        );
    });

    it("keeps serving everything else when the mobile transport cannot attach", async () => {
        const runtime = arrangeRuntime(false);
        runtime.attachMobileTransport.mockImplementation(() => {
            throw new Error("already attached");
        });
        const closeSocket = vi.fn();
        mocks.bindAgentSocket.mockResolvedValue({
            close: closeSocket,
            socketPath: "/tmp/happy-team/server.sock",
        });
        arrangeHttp(vi.fn());

        const daemon = await startHappyAgentDaemon();

        expect(closeMobile).toHaveBeenCalledOnce();
        expect(daemon.socketPath).toBe("/tmp/happy-team/server.sock");
        await daemon.close();
        expect(closeMobile).toHaveBeenCalledOnce();
        expect(closeSocket).toHaveBeenCalledOnce();
    });

    it("opens Tailcat around the active transport and closes it with the daemon", async () => {
        const runtime = arrangeRuntime(true, true);
        const closeHttp = vi.fn();
        arrangeHttp(closeHttp);
        const daemon = await startHappyAgentDaemon();

        expect(runtime.attachTransport).toHaveBeenCalledWith(expect.anything(), {
            host: "127.0.0.1",
            port: 3_000,
        });
        expect(daemon.tailcat).toEqual({ address: "tcTailcatTestAddress", port: 43_210 });

        await daemon.close();
        expect(runtime.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
            closeHttp.mock.invocationCallOrder[0]!,
        );
    });
});

function arrangeRuntime(
    teamModeEnabled: boolean,
    tailcatEnabled = false,
): {
    readonly attachMobileTransport: ReturnType<typeof vi.fn>;
    readonly attachTransport: ReturnType<typeof vi.fn>;
    readonly beginDrain: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
    readonly shutdown: ReturnType<typeof vi.fn>;
} {
    const ctx = createRootContext();
    const configuration = {
        paths: {
            pidPath: "/tmp/happy-team/daemon.pid",
            socketPath: "/tmp/happy-team/server.sock",
            tailcatAddressPath: "/tmp/happy-team/tailcat/address",
            tailcatHome: "/tmp/happy-team/tailcat",
            tailcatKeyPath: "/tmp/happy-team/tailcat/default.private.json",
            tailcatPortPath: "/tmp/happy-team/tailcat/port",
            tokenPath: "/tmp/happy-team/token",
        },
        values: {
            feature: {
                tailcat: { enabled: tailcatEnabled },
                team: {
                    enabled: teamModeEnabled,
                    host: "127.0.0.1",
                    port: 3_000,
                    workosClientId: "client_test123",
                },
            },
        },
    };
    const status = tailcatEnabled
        ? {
              address: "tcTailcatTestAddress",
              enabled: true,
              port: 43_210,
              state: "open",
          }
        : { enabled: false, state: "disabled" };
    const attachTransport = vi.fn(async () => status);
    const attachMobileTransport = vi.fn();
    const runtime = {
        api: {
            onShutdown: vi.fn(() => vi.fn()),
            beginDrain: vi.fn(),
            drainProgress: vi.fn(() => [{ name: "agent-system", count: 1 }]),
        },
        modules: {
            mobileConnector: { attachTransport: attachMobileTransport },
            tailcat: {
                attachTransport,
                currentStatus: vi.fn(() => status),
            },
        },
        close: vi.fn(async () => undefined),
        configuration,
        ctx,
        shutdown: vi.fn(async () => undefined),
    };
    mocks.startHappyAgentRuntime.mockImplementation(
        async (options: {
            readonly onPrepared: (prepared: {
                readonly api: typeof runtime.api;
                readonly configuration: typeof configuration;
                context(name: string): ReturnType<typeof createRootContext>;
            }) => Promise<void>;
        }) => {
            await options.onPrepared({
                api: runtime.api,
                configuration,
                context: () => ctx,
            });
            return runtime;
        },
    );
    return {
        attachMobileTransport,
        attachTransport,
        beginDrain: runtime.api.beginDrain,
        close: runtime.close,
        shutdown: runtime.shutdown,
    };
}
