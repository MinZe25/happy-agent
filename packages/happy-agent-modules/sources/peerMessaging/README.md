# Peer messaging

`PeerMessagingModule` owns a separate authenticated WebSocket listener, agent inbox
delivery, common management/send tools, and bounded credential-free diagnostics.
It depends only on Config, Bots, and Durable Functions. Configuration owns the
machine settings and atomic runtime writer; Bots supplies administration
authority; Durable Functions applies transactional settings intents and owns
long-lived reconnect workers. `PeerSession` owns one full-duplex handshake,
message/ack/ping exchange, bounds, cancellation, and socket cleanup.

```text
desktop connector ---- one outbound WebSocket ---- server accept listener
agent inbox       <--------- messages -----------> agent inbox
```

The listener implements only the contract in
[`API_P2P.md`](../../../happy-agent/API_P2P.md). System Tailscale may supply private
connectivity; no embedded carrier or main daemon API is exposed. Upgrade requests
authenticate a configured node before session allocation. The desktop never
binds a peer port, and accept records require no reverse URL. Agent-role messages use
separate peer provenance, never local sender or user authorization metadata.
Stable, source-scoped inbox IDs provide durable repeated-delivery protection.
Reconnection retains no pending message payloads and never replays sends.
