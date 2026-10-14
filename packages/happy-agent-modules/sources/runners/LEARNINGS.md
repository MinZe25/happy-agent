# Runners learnings

## Runners have fixed tokens, not a join flow

An invitation and join step was proposed first. The person deploying a team node is usually an
agent running elsewhere, and it already writes the node's machine `happy.toml`; a join flow would
have needed a tool on the node and a second round trip for every runner. Each runner now has a
fixed token in `[runners.<id>]`, written to both machines at deployment, so a runner can be
provisioned before the node first starts. Removing the entry and restarting revokes it.

## The runner dials the daemon

Runners usually sit behind NAT and must not need an inbound port, so the runner opens the
connection and keeps it open. Both standalone and team nodes keep their listeners private behind
Tailcat, so `happy-agent runner` accepts a `tailcat:<address>[:<port>]` endpoint and dials through
the same embedded carrier the daemon uses for remote connections; `https://`, `http://`, and
`unix:` endpoints remain for private networks and local tests.

## One machine abstraction, not local and runner branches

The first port gave projects, workspaces, and Git separate local and runner implementations. The
user asked for one path: run the commands on a compute that is either this machine or a runner.
`machine(runnerId?)` now returns this machine's host compute or the runner's product compute, and
folder work is written once against it. The only remaining differences are capabilities this
machine has natively — the FFF index, non-recursive file watches, the SDK's restricted-environment
stdio transport for MCP, and the native Bun proxy fast path. The daemon's embedded Git tracking
(live snapshots, working-tree watches, untracked counts) is legacy and deliberately not ported to
runners; Git commands that create worktrees and clones do run there.

## Everything that touches a folder runs on the runner

Git, workspace checkouts, terminals, file watching, services, and the workspace proxy were all
asked for explicitly, not only agent commands. Sandboxed services are the exception for now: the
runner protocol has no isolated-services capability, so starting one for a runner or container
agent fails with a message naming runners. Once any runner is configured nothing runs on the
daemon's machine and nothing falls back to it: a disconnected runner is an error that names it.
Repository tokens still never leave the daemon — Git on a runner reaches back to the daemon's
credential proxy through a loopback listener carried over the runner connection.

## A runner that is away fails at once

Each call on an absent runner used to wait ten seconds for it to return, so an agent turn that
reads AGENTS.md, skills, and its folder before inference stalled for minutes before failing. The
wait now counts from the moment the runner went away: a brief drop is still bridged, and once the
window has passed every call answers `runner_unavailable` immediately.

## Separate Linux users are local runners started through sudo

The request was to run agent work as a Linux user other than the daemon's, so that agent commands
cannot read the configuration, database, or credentials, with specific bots able to use a user of
their own. Every path that touches a folder is already written against a runner's compute, so each
user gets a local runner, started as `sudo -n -u <user> -- happy-agent runner --stdio` and spoken
to over stdio with the unchanged runner protocol, rather than a second, sudo-aware execution path.
The sudo command line is fixed and minimal so the sudoers rule can allow exactly that command; the
spawn passes only `PATH` and starts in `/`.

It fails closed: a missing sudo rule, an unknown user, a runner that stops before it is ready, or
an `id -un` that does not name the configured user fails the work with a message naming the user
and the reason, and nothing falls back to the daemon's user. A user that is the daemon's own is
refused, because it would only look separated. The daemon still starts when the default user's
runner cannot, so the operator can read the log and fix the sudo rule. Per-bot users are keyed by
bot ID, and an agent's user is unknown until `BotsModule` has bound its bots, so `userFor` refuses
until then instead of choosing the default.

`[execution]` cannot be combined with `[runners]`: with runners, no work runs on the node's machine
at all, and that is the stronger separation. The API stays unchanged — folders are ordinary
folders on this machine — so a workload user that cannot start answers `503 runner_unavailable`.
