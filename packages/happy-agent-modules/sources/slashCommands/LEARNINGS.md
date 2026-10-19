# Slash command learnings

## Startup optimization preserves required discovery

The API requires catalog loading on creation and restoration, before every turn, and before
invocation. Skipping restoration or deferring it until a client opens the agent would violate that
contract. Startup now benefits from Skills sharing concurrent equivalent scans and batching metadata
reads; each agent still loads its own complete catalog and publishes its own changes.

Restoration starts every agent's load but no longer waits for it. Awaited, the loads held readiness
for about two of the three seconds a restart of a thousand agents took, because the restore
transactions serialize and so the scans rarely overlapped to be shared. Four restored agents load
at a time behind the daemon becoming ready; a catalog read, an invocation, or a turn for an agent
still waiting loads it immediately through the same coalesced refresh, so no reader sees less than
before.

## Loading latency needs stage-level traces

Restoring hundreds of agents can spend seconds rebuilding command catalogs. A single hook duration
does not distinguish context lookup, skill discovery, and event publication. Command loading now
records nested spans for those stages and each contributor, with skill discovery split into compute
resolution and filesystem scanning. Cached reads do no discovery, and concurrent refreshes still
share one load. Span names contain stable operations and module names, not agent IDs or file paths.

## Command images are separate resources

Command catalogs and events carry only the image ThumbHash needed for immediate rendering. The
module keeps the complete bytes beside the cached private command owner, and the API serves them
from the focused command image endpoint with a content-derived ETag. This keeps bootstrap and live
events small while still making image changes observable through catalog replacement events.
