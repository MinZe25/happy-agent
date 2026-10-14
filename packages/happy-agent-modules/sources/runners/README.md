# Runners

`RunnersModule` owns the runners this installation works on. A runner is a separate machine that
holds project folders and runs everything that touches them, while this daemon keeps the database,
provider credentials, and inference. The protocol between them lives in
`@slopus/happy-agent-compute` (`sources/runner/README.md`); this module is the daemon's side of it.

`[runners.<id>]` in machine `happy.toml` lists each runner with a name and a fixed token, and
`[runners] default` picks the one new folders go to. The configuration module validates the
entries; this module only reads them. There is no join step: whoever deploys a node writes the
same token to the node and to the runner.

A runner dials `GET /v0/runners/connect` with its token. The API asks `authenticate` which runner
the token belongs to, refuses anything else before the upgrade, and hands the WebSocket to
`acceptWebSocket`. Each runner has one `RunnerLink` for the life of the daemon process; a newer
connection replaces an older one, and a drop within the lease finds everything where it was.

The public list — names, connection status, the machine each runner last reported, and the
protocol in use — is one persisted snapshot. `getSnapshot(ctx)` reconciles it with configuration
inside the caller's transaction and `onUpdated` fires after commit; the API forwards it as
`runners.updated`. The stored machine report survives restarts, so a runner's home directory is
known before it reconnects.

Other modules ask this one where work runs:

- `enabled` — once any runner is configured nothing runs on this machine, and
  `assertLocalExecution()` refuses with `409 local_execution_disabled`.
- `place(runnerId?)` — the runner a new folder goes to: the one named, or the default.
- `machine(runnerId?)` — the machine Happy's own work on a folder runs on: this machine when no
  runner is named (refused once runners are configured), or the runner's product machine. Folder
  management, setup commands, Git, terminals, file reads and watches, the workspace proxy, and
  MCP stdio servers are each written once against this compute, whichever machine it is. A
  runner's machine is created once and kept.
- `run(ctx, runnerId, options)` — one bounded program on that machine, for Git and copying.
- `agentMachine(ctx, …)` — one agent's machine in its workspace folder, optionally in a Docker
  container on the runner. Agent commands never run on the product machine.

Work on a runner that is not connected, or no longer configured, fails with
`RunnerUnavailableError`, which the API reports as `503 runner_unavailable`. Nothing falls back to
this machine.

## Work as separate Linux users

`[execution]` in machine `happy.toml` names the Linux user agent work runs as on this machine, and
`[execution.bots.<botId>] user` gives specific bots a user of their own. For each user, the module
starts a local runner through sudo — `sudo -n -u <user> -- <executable> runner --stdio`, built by
`impl/sudoRunnerCommand.ts` with a fixed `PATH` and nothing else from the daemon's environment —
and speaks the same runner protocol over its standard input and output (`stdio.ts`, a 4-byte
big-endian length before each frame). `impl/LocalUserRunner.ts` owns that process: it starts it on
first use, explains why it would not start, and restarts it with backoff if it stops later.

Before any work runs there, the module runs `id -un` on the runner and stops it unless the answer
is the configured user; a user that is the daemon's own is refused. The default user's runner is
started while the daemon starts, so a missing sudo rule shows up in the log at once, but a failure
does not stop the daemon.

Nothing about this is visible in the API: folders stay on this machine with no runner, and
`native(runnerId?)` is what other modules ask before taking a fast path that works in the daemon's
own process. It is true only when no runner is named and `[execution]` is not configured.
Otherwise `machine()` returns the default user's product machine, `machineHome()` its home
directory (which is where new folders go), and `localAgentMachine()` an agent's machine as the
user `userFor(ctx, agentId)` chooses. `BotsModule` binds bots to users with `bindBots` while it
starts and `bindBot` as each bot is created; until then `userFor` refuses rather than guessing.
A runner that will not start fails the work with `RunnerUnavailableError`, whose message names the
user and the reason. Nothing falls back to the daemon's user.
