/** One program to start, exactly as `spawn` takes it. */
export interface LocalRunnerCommand {
    readonly program: string;
    readonly args: readonly string[];
    /** The complete environment; nothing of the daemon's own environment is added to it. */
    readonly environment: Readonly<Record<string, string>>;
}

/**
 * The search path sudo is found on. It is also all the runner is told about the daemon's
 * environment: provider keys and tokens in the daemon's environment never reach a workload user,
 * whatever the host's sudo policy keeps.
 */
const SUDO_SEARCH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * How the daemon starts a runner as another Linux user: `sudo -n -u <user> -- <executable>
 * runner --stdio`.
 *
 * `-n` makes sudo refuse instead of asking for a password nobody is there to type, so a missing
 * sudoers rule fails at once. The arguments after `--` are fixed, so one sudoers line naming
 * exactly this command and these users is all the daemon needs, and all it can use.
 */
export function sudoRunnerCommand(user: string, executable: string): LocalRunnerCommand {
    // Configuration has validated both already. These checks stay because they are what keeps
    // either value from ever reaching sudo as an option, a group, a numeric ID, or a relative path.
    if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(user) || user === "root") {
        throw new Error(`"${user.slice(0, 64)}" is not a Linux user agent work may run as.`);
    }
    // oxlint-disable-next-line no-control-regex
    if (!/^\/[^\u0000-\u001f\u007f]*$/u.test(executable) || executable.length > 4_096) {
        throw new Error("The happy-agent executable must be named by its absolute path.");
    }
    return {
        program: "sudo",
        args: ["-n", "-u", user, "--", executable, "runner", "--stdio"],
        environment: { PATH: SUDO_SEARCH_PATH },
    };
}
