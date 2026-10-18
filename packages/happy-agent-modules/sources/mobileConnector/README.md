# Mobile connector

Phones pair with this daemon by scanning a QR code and then reach it directly over a dedicated,
private Tailcat socket. `MobileConnectorModule` depends on Config, Team, Node, Tailcat, and
Durable Functions.

```text
phone ── Tailcat (own identity, mobile.private.json) ── relay 127.0.0.1:24781
                                                            │
                                                            ▼
                                      mobile listener (127.0.0.1:ephemeral)
                                        ├── /mobile/v1/pairing/*   unauthenticated
                                        └── everything else        device token only
                                                                   → serveDeviceRequests handler
```

The listener never sees the main API socket and never accepts the local standalone token, WorkOS
or JWT tokens, runner tokens, or bridge tokens. Only `TailcatModule.openExposure` is used to reach
Tailcat.

## The socket opens on demand

`#reconcile` opens the socket while the feature is enabled and either a pairing is active, a
device is paired, or a pairing ended less than three seconds ago, and closes it otherwise. The
linger lets the answer to the request that ended a pairing, and the phone's woken status read,
reach the phone. Device inserts and deletes schedule the same reconciliation through Durable
Functions in their own transaction, and `afterStart` reconciles in the background, so a restart
reopens the socket when devices exist without holding up startup. Its status is `disabled`,
`closed`, `starting`, `open`, or `failed`.

## Pairing

`impl/MobilePairing.ts` is one pairing's memory-only state machine:

```text
waiting ──start──▶ committed ──reveal──▶ verifying ──both confirmed──▶ completed
   └───────────────────┴─────────────────────┴──▶ rejected | expired | cancelled | failed
```

- `startPairing` replaces the caller's previous pairing, opens the socket, and shows
  `happy://direct?<base64url JSON>` with the address, port, one-time token, node name, and expiry.
- The token lives only in memory, expires after five minutes, and is consumed by the phone's
  `start`, whatever happens next. Each owner has one pairing at a time.
- The phone commits to `SHA256(label ‖ A ‖ Nm)` before it learns the daemon's key. A wrong
  commitment, an unusable key, or a wrong confirmation MAC fails the pairing.
- The desktop's `confirmPairing` and the phone's confirmation arrive in either order. When both
  have, one transaction inserts the device with the SHA-256 of its derived token, then the
  pairing forgets its secrets and gives the phone the daemon's MAC.
- A finished pairing stays in the owner's snapshot, and readable by its handshake ID, until the
  next start or cancel. Cancelling an active pairing ends it; cancelling a finished one dismisses
  it; anything else changes nothing.

`impl/mobilePairingCrypto.ts` implements the daemon's half of
[`API_MOBILE.md`](../../../happy-agent/API_MOBILE.md) on Node's crypto, and `impl/callsEmoji.ts`
carries Telegram iOS's emoji table. They are the only implementation in this repository; phones
implement the same document natively. The tests' fake phone, in `tests/mobileConnector/support`,
is written from the document independently of `impl/`.

## Owners, devices, and events

The owner comes from the caller's context: the team member's installation-local ID, or
`standalone`. No operation takes an owner as an argument. `revokeDevice` deletes the row and, after
commit, destroys every socket that device's requests are using. A device's `lastSeenAt` moves at
most once a minute. `onEvent` delivers `{ owner, mobileConnector }` after each change commits,
with a UUIDv7 `version` per owner.

## Storage

Migration `001-mobile-devices` creates `happy_agent_mobile_devices`: ID, owner, name, platform,
the unique hex SHA-256 of the device token, `created_at`, and `last_seen_at`.
