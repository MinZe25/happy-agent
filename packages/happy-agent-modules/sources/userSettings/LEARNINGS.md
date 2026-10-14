# User settings — learnings

## Settings are opaque and belong to one person

The desktop kept per-person choices, such as a connection's completion sound and which bots are
muted or hidden, in the browser's local storage, so they never followed the person to another
device. Steve asked for opaque per-user key-value settings with proper sync instead. The module
checks only key format, JSON shape, and sizes. It never interprets a value, has no tools, and never
reaches agent context, so a new preference needs no daemon change.

The owner always comes from the caller's context: a team member's local user ID, or `standalone`
for the installation's one person. No operation accepts an owner from a caller, so no route can
read or write someone else's settings, and standalone settings never become a member's.

## Sync is per key, and forgetting never resurrects

Each key is last-write-wins by the time the person made the change, like composer drafts. Two
additions keep that honest across devices:

- A supplied time ahead of the daemon's clock counts as the daemon's time. Otherwise a device whose
  clock runs fast could write a far-future time and lock the key against every later change.
- A clear is stored as a row with no value, so an older write from a stale device cannot restore
  the value. Only the 1,000 most recent clears are kept; forgetting one raises the owner's horizon
  to its time, and a write older than the horizon to a key holding nothing is stale. Bounded
  storage therefore never trades away the no-resurrection guarantee.

Versions come from each owner's persisted high-water mark rather than the clock, so they keep
increasing across restarts and a clock moved backwards. Every applied write mints one, including a
repeat or a clear of an empty key, so clients can always keep the greater version per key.

## Limits refuse only real growth

An applied write that adds a key past 1,000 or grows the total past 1 MiB is refused, and the
message names the limit. The stale check runs first, and clears and writes that do not grow the
total are never refused, so a full person can always clear their way back under the limits and a
stale device is answered with the stored entry rather than an error.

## No durable work

A write and its version are one transaction, and the only follow-up is the in-process event after
commit. There is nothing to resume after a crash, so the module does not use Durable Functions.
