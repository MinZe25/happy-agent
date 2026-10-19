import {
    createHostNetwork,
    createJustBashCompute,
    type Compute,
    type ComputeFileSystem,
    type HostComputeConfig,
} from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

/**
 * The machine a gym gives the agent instead of this computer.
 *
 * It is a just-bash shell and filesystem answered inside this process, mounted over the one folder
 * the agent was configured to work in. Commands run, files change, and `gym.readFile` sees the
 * result, but nothing outside that folder exists and no process is ever started on the host.
 *
 * The agent is told this is its host machine, because that is the substitution a gym makes: the
 * model is scripted and the machine is emulated, and everything between them — the loop, the
 * tools, the permissions, the daemon, the database — is the real product. A test that needs the
 * real host boundary belongs in a suite that starts the agent with the host compute instead.
 *
 * The emulated machine shares this computer's loopback, so a test can serve a fixture the agent's
 * machine reaches. Every connection it opens is reported to `connected`, naming the machine by its
 * working directory, so a scenario can tell the agent's machine from the daemon's own network.
 */
export function createGymCompute(
    connected: (connection: GymMachineConnection) => void = () => undefined,
): (ctx: Context, config: HostComputeConfig) => Promise<Compute> {
    const network = createHostNetwork();
    return async (_ctx, config) => {
        // Discovery can resolve compute before workspace provisioning finishes. Leave an absent
        // folder absent: construction may fail now and be retried once its owner creates it.
        const machine = createJustBashCompute({
            cwd: config.cwd,
            folder: config.cwd,
            storage: "folder",
            ...(config.hostPolicy === undefined ? {} : { hostPolicy: config.hostPolicy }),
        });
        return {
            cwd: machine.cwd,
            dispose: async (disposeCtx: Context) => await machine.dispose(disposeCtx),
            fs: errnoFileSystem(machine.fs),
            id: "host",
            kind: "host",
            shell: machine.shell,
            network: {
                connect: async (connectCtx, options) => {
                    const connection = await network.connect(connectCtx, options);
                    connected({ cwd: config.cwd, host: options.host, port: options.port });
                    return connection;
                },
            },
        };
    };
}

/** One connection an emulated machine opened, named by the machine's working directory. */
export interface GymMachineConnection {
    readonly cwd: string;
    readonly host: string;
    readonly port: number;
}

/** Every call a compute filesystem answers, which is exactly what the agent may ask it. */
const FILE_SYSTEM_CALLS = [
    "chmod",
    "exists",
    "lstat",
    "lstatMany",
    "mkdir",
    "move",
    "realpath",
    "readFile",
    "readFileBuffer",
    "readdir",
    "readdirPage",
    "rm",
    "setModificationTime",
    "stat",
    "writeFile",
] as const;

/**
 * Make the emulated filesystem report a missing file the way a real one does.
 *
 * just-bash writes the errno into the message but leaves `error.code` unset, and callers above the
 * compute boundary — reading an absent `AGENTS.md`, for instance — decide whether a failure is
 * "this file is simply not there" from that code. Without it an ordinary missing file ends the
 * turn as an internal error, which is not how the same agent behaves on a real machine.
 *
 * `@slopus/happy-agent-compute` now normalizes these errors at the source (see
 * `withNodeStyleFileSystemErrors` in that package), but this gym depends on its published npm
 * build, pinned in `package.json`, rather than this repo's workspace source. Delete this wrapper
 * once that dependency is bumped past `0.1.6` and picks up the fix.
 */
function errnoFileSystem(fs: ComputeFileSystem): ComputeFileSystem {
    const wrapped: Record<string, unknown> = {
        cwd: fs.cwd,
        ...(fs.home === undefined ? {} : { home: fs.home }),
    };
    for (const name of FILE_SYSTEM_CALLS) {
        const call = fs[name] as (...args: unknown[]) => unknown;
        wrapped[name] = async (...args: unknown[]): Promise<unknown> => {
            try {
                return await call.apply(fs, args);
            } catch (error: unknown) {
                throw withErrnoCode(error);
            }
        };
    }
    return wrapped as unknown as ComputeFileSystem;
}

function withErrnoCode(error: unknown): unknown {
    if (!(error instanceof Error)) return error;
    if ((error as NodeJS.ErrnoException).code !== undefined) return error;
    const errno = /^(E[A-Z0-9]+):/.exec(error.message)?.[1];
    if (errno === undefined) return error;
    (error as NodeJS.ErrnoException).code = errno;
    return error;
}
