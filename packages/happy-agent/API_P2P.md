# Happy Agent peer messaging API

Version 1 is a separate authenticated WebSocket API. One installation initiates
an outbound connection to a reachable installation. Both send messages over that
same session. The initiating desktop needs no inbound port or reachable address.
The listener defaults off; the feature itself defaults off. The ordinary Happy
Agent API is never exposed through this session. There is no discovery, remote
configuration, relay, or agent enumeration.

## Settings and authentication

Machine `[peer_messaging]` settings contain `enabled`, `node_id`, `listen`, `host`,
`port`, and `peers`. `listen` defaults false. Only `listen = true` binds a server,
defaulting to `127.0.0.1:24780`. A connector peer has `role = "connect"`, a `url`
canonical WebSocket origin (`ws://` or `wss://`), and `token`. Its listener's reciprocal
peer has `role = "accept"` and the same token, without a URL. Each side names the
other by its configured node ID. `enabled = false` alone disables a peer entry.
Tokens are 43-character base64url encodings of 32 random bytes, distinct per
peer. Node IDs are case-sensitive ASCII labels of 1–64 letters, digits,
underscores or hyphens, beginning with a letter or digit. Enabling requires a
node ID. URLs contain no credentials, path, query, or fragment.

The connector requests `GET /p2p/v1/session` with a WebSocket upgrade,
`Authorization: Bearer <token>`, and `X-Happy-Peer: <source node ID>`. The listener
authenticates the configured accept peer before allocating a session. Invalid
credentials, a disabled/unknown peer, or the wrong role receive HTTP `401`.
A second live session for the same peer receives `409`; it cannot evict the
established session. Ordinary HTTP requests receive `404`. Redirects are never
followed. TLS may terminate at an external proxy; system Tailscale can provide
private encrypted connectivity. This feature does not install Tailscale or
start an embedded Tailcat carrier.

## Session establishment

All data frames are UTF-8 JSON text. The listener sends:

```json
{ "type": "hello", "version": 1, "nodeId": "server", "sessionId": "s123456789012345678901234" }
```

The connector verifies the expected listener node and version, then sends:

```json
{ "type": "ready", "version": 1, "nodeId": "desktop", "sessionId": "s123456789012345678901234" }
```

The listener verifies the authenticated source node and session identity and
returns `ready` with its own node ID and the same session ID. Both are now ready.
No message admission is permitted before this exchange. Handshake completion is
bounded to ten seconds. Wrong identity, version, order, or malformed frames
close the session. Unknown fields are invalid. A session ID identifies this live
connection, independently of durable message identity.

## Messages and acknowledgments

Either side sends:

```json
{
    "type": "message",
    "requestId": "q123456789012345678901234",
    "message": {
        "messageId": "m123456789012345678901234",
        "fromAgentId": "a123456789012345678901234",
        "toAgentId": "b123456789012345678901234",
        "text": "Please run the build."
    }
}
```

The session already selects the receiving node; the body has no destination
node. Agent, request, session, and message IDs use Happy Agent's cuid2 format.
Text contains 1–16,384 characters. The source installation asserts its Agent ID;
the token authenticates the installation, not each asserted agent separately.

The receiver durably admits the message to that known non-archived local Agent
ID, steering an active run or resuming an idle one. It replies on the same socket:

```json
{
    "type": "ack",
    "requestId": "q123456789012345678901234",
    "messageId": "m123456789012345678901234",
    "accepted": true
}
```

Admission failure returns `accepted: false` with a bounded, human-readable
`error`. It does not return raw database errors or remote response content.
An acknowledgment proves inbox admission, not completion of the agent's work.
Request IDs correlate acknowledgments on this session. A mismatched message ID
in a correlated acknowledgment closes the session; late unknown acknowledgments
are ignored. Each request has a ten-second deadline.

The stored inbox ID derives deterministically from authenticated source node and
wire message ID. Repeating that message to the same recipient preserves the
original message, including after reconnection or daemon restart. Never reuse a
message ID for different content or a different recipient. Messages have agent
role, source-node/source-agent text and separate peer provenance; they are never
human authorization or local collaborator authority.

If an acknowledgment is lost, delivery may have happened. Failed sends expose
their message ID for a deliberate retry. Disconnect, timeout, or reconnection
never automatically replays or queues messages. A caller must explicitly retry
with the same message ID when appropriate.

## Health, reconnect, and bounds

Health checks use a WebSocket control ping with a fresh correlation ID and wait
up to ten seconds for its matching pong on the existing authenticated session.
The accepting node never reverse-dials. Both sides also ping every thirty
seconds; a missing pong closes the session. Idle sessions therefore stay live
while half-open connections are detected.

Durable Functions owns one connector worker per configured connect peer. It
reconnects after closure with backoff from one to thirty seconds, retaining no
message payloads. Restoration resumes connectivity, not pending sends. Settings
rotation, revocation, disabling, and shutdown cancel the relevant sessions and
workers. Cancellation and replacement worker admission share one transaction;
connector workers never hold the settings-mutation lock.

Frames are limited to 128 KiB; binary frames and compression are unsupported.
There are at most 32 pending outgoing requests and 32 incoming admissions per
session, with at most 32 admissions across the installation. Buffered outgoing
data is bounded to 1 MiB. Excess frames or protocol violations close the session;
send-side saturation fails without queueing. The listener caps sockets at 128,
headers at 8 KiB and header/upgrade time at ten seconds. Disconnection cancels
uncommitted admissions; shutdown drains owned work with a bounded deadline.

## Tools and configuration lifetime

Active admin bots use `configure_peer_messaging`, `set_peer_connection`,
`remove_peer_connection`, `check_peer_connection`, and `debug_peer_connections`.
Administration rechecks bot authority at execution. `send_peer_agent_message`
is available to agents while the feature is enabled. Its `node_id` chooses a
configured session; `to_agent_id` chooses the recipient. All contacting or
configuration tools declare their external boundary for Auto review.

Configuration operations acknowledge `{ "accepted": true }` when the mutation
intent is durably admitted. Durable Functions updates daemon-owned private
`runtime.toml` and reconciles sessions after commit. A rollback admits no intent;
transactional tools commit intent and tool result together. Poll debug for
applied settings, listener state, peer role, connected status, common session ID,
and safe last-operation diagnostics. Tokens and message content are never
included. Settings-application failures appear as safe debug errors.

Only machine settings configure this feature; project files cannot expose it or
choose its credentials. The Chief of Staff configures both installations through
independently authorized administration access. The peer session itself grants
only messages to known Agent IDs.
