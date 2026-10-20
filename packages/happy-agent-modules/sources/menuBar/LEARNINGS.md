# Menu bar learnings

## Native status controls on macOS and Windows

macOS uses Swift AppKit. Windows now has a native notification-area app, requested to make a
background daemon visible and stoppable. It uses Windows Forms from the system .NET Framework,
with no Electron runtime. Linux still has no status app. The Windows icon is stationary and
resource/usage refreshes run only while its menu is open; parent-exit and stdin EOF notifications
end its lifetime without a process-table polling loop.

## Only a released binary has a menu bar

The app used to start from any macOS build that had compiled it, which meant working on Happy
Agent, or running its tests, put a status item in the developer's menu bar and sometimes left one
behind. It now ships in the released Happy Agent binary alone: the binary build replaces
`resolveMenuBarApp` with a resolver for its embedded copy, and the source version returns nothing
at all. Do not restore the `dist/menuBar/bin` lookup to make a development daemon show the menu
bar; build the binary and run that instead.

## It is on by default, and turned off in configuration

Within a release the module starts the app whenever the daemon runs on macOS or Windows. There is no opt-in
flag; `menu_bar = false` under `[settings]` is the way off. The app itself decides whether a machine
actually has a menu bar, by checking for a login session, and exits cleanly when there is none — a
daemon started over SSH must not look like a failure.

Team mode is the deployment exception. It has no private local API socket or token, so it never
starts the socket-dependent menu bar app even when `menu_bar` retains its standalone default.

## The app never outlives its daemon

A daemon that is killed outright never runs its shutdown handlers, so the app has to notice on its
own. It watches two things, and either is enough: end of file on the standard input the daemon holds
open, and the exit of the parent process itself through a dispatch process source. Standard input
alone was the original mechanism and is not sufficient, because anything else holding that pipe open
keeps the app alive after the daemon is gone.

## The macOS status item shows no count and the menu has no footer

The bar carries the glyph alone: no number, no badge. The menu ends after plan usage — there is
no version line, no ready/draining state, and no Quit item. A Quit item would be a lie, because
the module would start the app again. These were explicit product decisions, not omissions.

## The menu is compact: one line per thing

The earlier menu grew to about 1,900 pixels: agents grouped by project on two lines each, a
title plus three full-width bars per account, and two token lines, with nothing scrolling. The
person asked for a minimal menu at native metrics — 13-point text, 22-point rows, standard insets
— and for everything not needed to go. Every row is now one line, the last day's tokens sit
quietly on the headline's right, and when the lists would pass 70% of the screen they scroll in
their own view below the headline, because NSMenu only scrolls at the screen edge. The rows are
replaced in place while the menu is open, so the once-a-second elapsed-time tick keeps the scroll
position.

## What the menu shows: tasks and bots

Tasks and bots are the core primitives, so they are the only things listed, by task or bot name,
with no grouping by project. Subtasks and subagents are never rows of their own; a task or bot
counts as working while its own agent, a running subagent, or any subtask under it is working.
The elapsed time sits right-aligned on the same line; the granular "Responding"/"Thinking" text is
gone. Idle tasks and bots are not listed at all, and the headline reads "3 working" or "All idle".

## Plan usage: what is left, as a ring per window

Each account is one line under a small vendor header: the friendly account name, the plan type in
secondary text, a ring for the session and one for the week, and the reset. The person asked for
remaining rather than spent, like a battery, so ring and number both show what is left; the ring
turns yellow under 25% left and red under 10% or for the window that has the account blocked.
Horizontal bars and rules were explicitly unwanted.

The earlier menu picked the single window closest to running out, which hid the week whenever the
session was tighter, so both are always shown. A monthly window appears only when there is no
session, so a Grok-style week-and-month pair still has both. Extra vendor meters such as Codex
Spark are not shown. Gauge columns are right-aligned so the same window lines up under every
vendor, and a header names them only when its columns differ from the vendor above.

Fable's weekly allowance never gets a gauge. A Fable column, shown whenever Fable was the tightest
window, narrowed every Claude row and cut off names and plans, so it was removed at the person's
request. Fable lives in the tooltip; when it is the window blocking the account, the week's ring
turns red in its place and the reset column shows Fable's reset in red.

The reset belongs to the window holding the account back — while any window is full, Fable
included, the full window that resets last — and is red while the account is blocked. Under a day
away it is a clock time, otherwise a weekday, or a date once a weekday would be ambiguous. The
row's tooltip spells out every window with its reset time, led by which limit was reached when
the account is blocked.

Reset times are always the viewer's local time: the Mac's own time zone and locale, followed as
the system changes, and never UTC, an ISO string, or the daemon's zone. This is a product-wide
preference.

Accounts follow the desktop model picker: configuration order, which is the order of `/v0/usage`
`providers`, with each vendor placed where its first account appears. Hidden accounts are left
out there, so they are left out here.

## The glyph is a star, drawn at full strength

The icon is a five-pointed star: still when nothing is running, turning slowly while agents work.
It replaced an equalizer of three bars, which was both the wrong mark and, at rest, indistinguishable
from an ellipsis.

Draw the template image with solid black and no alpha. An earlier version dimmed the resting glyph
to 55% alpha, which made it visibly washed out beside every other menu bar icon — macOS already
tints and inverts a template image, so anything less than full strength is wrong.

## Provider names are the person's, not the config's

A provider ID is whatever someone called their account, so `bulka_happy_codex` is shown as
"Bulka Happy Codex". Never render a raw ID.
Both native apps use configuration's friendly account name verbatim, with vendor context shown
separately: under a vendor header on macOS, and as "Codex · Current CLI" on Windows. The name is
never rewritten with a plan suffix or automatic email shortening; macOS shows the plan type as
separate secondary text beside it. Opening a menu calls the existing `POST /v0/usage/refresh`; ordinary snapshot
reads remain cached. macOS reacts to the existing usage events, while Windows reads cached
snapshots on its existing open-menu timer.

## The existing private API is the boundary

Both apps use the ordinary HTTP API over the daemon's private socket with its bearer token.
macOS remains read-only and uses events as refresh hints. Windows uses the existing shutdown
endpoint for its explicit Stop action; if shutdown stalls, Force stop terminates the retained
parent process and its tree. No new server endpoint, public listener, or token exposure is needed.

## Supervision waits for exit, not for the streams to close

`close` on a child process waits for its stdio to close, which anything the app leaves behind can
hold open indefinitely. Supervision therefore ends a run on `exit` and gives the error pipe only a
brief moment to drain. A test covering an app that leaves a grandchild behind catches a regression
here.
