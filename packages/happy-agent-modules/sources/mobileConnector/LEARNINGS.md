# Mobile connector learnings

## A finished pairing must not close the socket under its own answer

Closing the socket as soon as nothing needed it cut off the phone at the worst moment. A phone
whose "Doesn't match", bad MAC, or reveal ended the last pairing had its own request destroyed
before the answer was sent, and a long poll woken by a desktop cancel could lose its response.
Ending a pairing now starts a three-second linger, and reconciliation keeps the socket open until
the linger runs out. Device changes still converge through Durable Functions and the same
reconciliation, so the socket never stays open longer than that without a reason.

## The specification is the phone's only reference

Happy Agent ships no phone code: the native app implements pairing from `API_MOBILE.md` alone. A
TypeScript phone SDK was built first and then dropped for that reason, so the daemon's `impl/`
crypto and emoji table are the one implementation in this repository. `API_MOBILE.md` therefore
carries everything a phone needs, including the full emoji table, its checksum, and fixed
vectors. The tests' fake phone is written from that document, reads the emoji table out of it,
and never imports `impl/`, so its agreement with the daemon checks both against the spec.

## Phones use the ordinary API, minus administration

A paired phone acts as the user who paired it on every `/v0` route, served by the API module's
handler through `serveDeviceRequests`, except daemon lifecycle and debugging and mobile connector
management, which answer `403`. The phone can therefore neither stop the daemon nor pair or remove
other phones. WebSocket upgrades and `CONNECT` are not served on the phone socket in version 1.
