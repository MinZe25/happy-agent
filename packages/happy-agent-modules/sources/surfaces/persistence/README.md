# Surface storage

One module-owned key-value table backs AgentKV. `surface.*` and `todo.*` hold current snapshots;
`revision.*` holds immutable full revisions and `image.*` holds bounded managed WebP assets.
All SQL stays here. Revision reads use indexed key ranges and a SQL limit before decoding.

`happy_agent_surface_document_changes` is each document's permanent change log: one row per
`seq` with the Yjs update, its log entry, and the mutation ID, unique per document when present.
`happy_agent_surface_document_snapshots` holds the full state at some `seq` values, written every
256 changes or 1 MiB of changes since the last one, so a version is rebuilt from the nearest
snapshot plus a bounded replay. `document-log.*` in AgentKV is each document's head: the latest
`seq`, its latest snapshot, attribution, and size counters. A log row, its head, and any snapshot
share the caller's transaction. Nothing here is pruned.

`document.*`, `document-revision.*`, and `document-summary.*` are the Markdown snapshots,
revisions, and history summaries an earlier daemon wrote. They are never written again; the first
read or write converts a document into the log, and its revisions stay readable as history.

`happy_agent_surface_calendar_events` holds each calendar event's current record with padded
instant bounds (`upper_bound` null for endless series), indexed for range reads.
`calendar-revision.*` in AgentKV holds its immutable full revisions. Neither is pruned.

`reference.*` holds each reference Surface's immutable target binding. It is written once, with
the Surface, and never projected into events or reused across callers.

`chat.*` holds each Surface chat's reservation: the agent ID, workspace ID, folder path, runner,
and the winning request's mutation ID, written once before any filesystem work. `chat-agent.*`
and `chat-workspace.*` index the committed chat by its agent and its workspace. They are written
only with the Surface's `chatAgentId`, so a pending reservation is never reported as a chat.
