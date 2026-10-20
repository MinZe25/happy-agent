# Provider usage learnings

## Freshness belongs to each window, not to the reading

A Claude report about overage alone used to produce a reading with no windows; the merge carried
the old windows forward and stamped the whole reading with the current time, so numbers hours old
looked just measured. Each window now carries its own `capturedAt`, a carried window keeps it, and
a report that measured no window moves neither the reading's `capturedAt` nor `refreshedAt`.

## A failed read must be visible beside the reading it failed to renew

A failed poll used to keep the old reading, stamp `checkedAt`, and clear `error`, which made a
throttled account indistinguishable from a healthy one. Entries now carry `refreshedAt` for the
last success, `refreshError` for the last failure, `retryAt`, and `refreshing`; `error` keeps its
older meaning for compatibility.

## Clients are told, not made to poll

The human asked for usage changes to be pushed as `provider.usage.updated` and for an hourly
background poll instead of fifteen minutes, overriding master plans 11 and 12 for this work; those
plans still describe polling clients and a fifteen-minute cadence until the human amends them.
In-band readings carry an account in use; the hourly poll covers cold starts and idle accounts;
`POST /v0/usage/refresh` lets a client ask for fresher readings without waiting.

## Read a blocked account again as soon as it can work

The human asked that an account blocked by a window be read again just after that window resets,
so a client learns quickly that inference is unblocked. Vendors' resets can be soft, so a read that
still finds the same window full backs off briefly before giving up to the hourly poll.

## Claude's usage method follows its credential

Setup tokens and gateway tokens can never read the OAuth usage endpoint, and asking it only
spends that endpoint's rate limit. The method is chosen from the credential instead of a setting:
a login with `user:profile` asks the endpoint, everything else measures inference headers. A `429`
falls back to the headers immediately rather than leaving a stale reading on screen.
