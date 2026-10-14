# Peer messaging learnings

## The connection selects the receiving node

The initial message body repeated a destination node ID even though its network
connection already selected the receiving installation. The peer API now carries
only message identity, source Agent ID, recipient Agent ID, and text. The sending
tool selects a configured peer connection; authenticated health checks verify its
expected node identity. This keeps node routing out of the agent message body.

## One outbound session carries both directions

Requiring reciprocal HTTP reachability made desktops difficult to connect. One
node now opens an authenticated WebSocket to an explicitly enabled listener;
both nodes send over that same session. The connector binds no peer port and the
accepting peer has no reverse URL. Connectivity reconnects independently through
Durable Functions while message requests are never automatically replayed.

## Administration tools declare their discovery metadata

Peer administration tools were deferred without capabilities or search keywords. Each definition
now owns both, so connection setup, removal, health checks, and local diagnostics remain
discoverable through the ordinary tool search alongside message sending.
