# Menu bar

A small native macOS app that puts the agents in the system menu bar. Clicking it shows a compact,
read-only menu:

```text
3 working                    1.3M tokens in 24h
──────────────────────────────────────────────
Fix the login redirect loop            14m 3s
Chief of Staff                          1m 44s
Release 0.42 preview                       5s
──────────────────────────────────────────────
CLAUDE                  Session   Week  Resets
Current CLI  Max 20x     64% ◔    82% ◕  3:30 AM
Work  Max 5x             19% ◔    56% ◑  Thu
CODEX
Current CLI  Pro         88% ◕     9% ◔  Wed
```

- The headline counts the working tasks and bots, and carries the last 24 hours of tokens as a quiet
  aside.
- Only tasks and bots are listed, one line each, by name, with how long they have been working.
  A task or bot counts as working while its own agent, a subagent, or any subtask under it is
  working. Idle ones are not listed.
- Plan usage is grouped by vendor, one line per account: the configured account name, the plan
  type, a small ring for the session and the week showing what is left, and when the window
  holding the account back resets, in the Mac's local time. Rings turn yellow under 25% left and
  red under 10% or when the account is exhausted. Claude's Fable allowance has no ring; it is in
  the row's tooltip, and when it blocks the account the week ring and the reset turn red.
- When the lists would take more than 70% of the screen, they scroll below the headline instead
  of the menu growing.

```text
MenuBarModule ──spawns──> happy-menu-bar (Swift, AppKit)
      │                          │
      └── ConfigModule           └── GET /v0/bots, /v0/tasks, /v0/usage, /v0/config
          socketPath, tokenPath      GET /v0/events/stream
```

The app is a reader. It speaks the ordinary Happy Agent HTTP API over the same private Unix socket
every other client uses, with the same bearer token, so it can show nothing the person could not
already see and can change nothing at all.

The event stream is used only as a signal that something changed; the snapshots the menu draws are
always re-read. `agent.*`, `task.*`, and `bot.*` events re-read the tasks and bots;
`provider.usage.updated` and `config.updated` re-read plan usage. An unfamiliar or missed event
therefore cannot leave stale state on screen.

Accounts are listed in the order the desktop model picker uses: configuration order, with each
vendor placed where its first account appears, so Claude comes first and the built-in Current CLI
account leads its vendor. Hidden and disabled accounts are left out.

## Only in a release

The app ships in the released Happy Agent binary and nowhere else. The binary embeds the executable
and replaces `impl/resolveMenuBarApp.ts` with a resolver that materializes it; the version in the
source tree always answers "no app", so a daemon started from a checkout, a development run, or a
test never puts a status item in anyone's menu bar. To see the menu bar while working on it, build
the binary with `pnpm --filter @slopus/happy-agent build:bun` and run that.

## Lifetime

The module starts the app, restarts it if it falls over, and stops it during shutdown. The app never
outlives the daemon that started it: it watches both its own standard input, which the daemon holds
open and nothing writes to, and the parent process itself. A daemon killed outright never gets to
stop its children, so either signal is enough to take the menu bar down with it.

An exit code of zero means the app found no menu bar to join — a daemon running over SSH, for
instance — and the module stops trying rather than reporting a failure.

## Building the app

`sources/menuBar/native` is compiled by `scripts/build-menu-bar.mjs` into
`dist/menuBar/bin/happy-menu-bar-<platform>-<arch>`, which is what the standalone Happy Agent
binary embeds. It is a plain Swift executable rather than an application bundle: it never opens a
window, so it needs no `Info.plist`, and one file is what the binary can carry. Building on any
platform other than macOS produces nothing.

## Turning it off

```toml
[settings]
menu_bar = false
```
