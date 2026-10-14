# User settings

Each person's small, opaque key-value preferences, kept on the daemon so they follow that person
from device to device. Applications such as the desktop store their own choices here under keys
prefixed with their name. The module checks only shapes and sizes and never interprets a value. It
has no tools and never puts settings in front of an agent.

It depends only on the team module, to tell team mode from standalone and to find the
authenticated member.

## Owners

Every operation takes its owner from the caller's context; no caller names one. In team mode the
owner is the member's installation-local Happy user ID, and a context without a member throws
`TeamAuthenticationError`. Standalone, the owner is `standalone`, the installation's one person.
Team user IDs are cuid2 values, so standalone settings are never assigned to a member.

## Public operations

- `list(ctx)` returns every key held for the caller, values and retained clears, in ascending key
  order.
- `get(ctx, key)` returns one entry. A key holding nothing has `value`, `updatedAt`, and `version`
  all `null`.
- `save(ctx, key, { value, updatedAt? })` sets a value, or clears the key with `null`, and returns
  the authoritative entry.
- `onEvent(listener)` delivers each applied write as `{ owner, setting }` after its transaction
  commits. A failing listener is logged and cannot undo the write.

A refused operation throws `UserSettingsError` with `invalid_request` for a malformed key, value,
or time, `too_large` for a value over 64 KiB as compact JSON, and `settings_full` when an applied
write would add a key past 1,000 or grow the person's total past 1 MiB. Its message names the limit
and is safe to show.

## Writes

Each key is last-write-wins by `updatedAt`, the time the person made the change. A supplied time
ahead of the daemon's clock counts as the daemon's time; an omitted one always applies at the
daemon's time. A write older than the stored entry is stale: it changes nothing, emits nothing,
and returns the stored entry. Stale writes are never refused as full, and neither are clears or
writes that do not grow the total.

Every applied write, including a repeat of the stored value or a clear of a key holding nothing,
mints a UUIDv7 strictly greater than the last one minted for that person and emits one event.
The read, the comparison, and the write are one transaction, so writes to one person serialize.
`save` joins a transaction its caller already holds, and its event waits for that commit.

## Clears

A clear is kept as a row with no value, so its `updatedAt` stops an older write from bringing the
value back. Each person keeps their 1,000 most recent clears. Forgetting older ones raises that
person's horizon to the newest forgotten `updatedAt`; a write older than the horizon to a key
holding nothing is stale. The clear being written is never the one forgotten.

## Storage

Migration `001-user-settings` creates two tables. `happy_agent_user_settings` holds one row per
owner and key, with the compact JSON value, or `NULL` for a clear, and the bytes the row counts
toward the total: the key and value in UTF-8, or zero for a clear.
`happy_agent_user_settings_owners` holds each owner's last minted version and horizon, so versions
keep increasing across restarts and a clock moved backwards.
