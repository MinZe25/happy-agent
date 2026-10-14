# Master plan 27: Peer messaging

Connect two Happy Agent installations so an agent on one can send a message to
a known agent on the other. Keep this first slice small: the sender knows the
destination node and Agent ID. There is no node or agent discovery.

This request supersedes plan 15's conflicting transport, ordering, and discovery
requirements for this slice. One persistent WebSocket session authenticated with
a shared token is enough to deliver messaging now; the broader identity,
invitation, authority, profile, and discovery work in plan 15 is future work,
not part of this delivery.

First, describe the peer WebSocket contract in a separate `API_P2P.md`. Keep it
separate from the existing Happy Agent API specification.

Next, opt into a dedicated peer listener on the reachable installation, using
direct connectivity, Tailscale, or tailcat. The other installation connects
outbound once and keeps that WebSocket session open. It needs no peer listener,
inbound port, or reverse connection URL, so a desktop can connect from behind
NAT. Authenticate the session with a shared token and let both installations
send messages over that same session. Sending requires the known node and Agent
ID; it does not search for the recipient.

Then expose the settings and agent tools needed to configure the listener and
outbound connection, check the link, and send messages. Provide health checks
and show session status and debugging information in the same spirit as the
existing connections view.

Finally, provide a recipe for the Chief of Staff to configure both installations
and check that the link works in both directions. Setup is complete when the
outbound-only installation and the reachable node exchange messages addressed
to known Agent IDs over one persistent session, the connection can be checked
and debugged, and the Chief of Staff can perform that setup using the recipe.
