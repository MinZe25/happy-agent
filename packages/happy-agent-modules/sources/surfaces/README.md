# Surfaces

Shared typed feature instances, including todo lists, collaborative documents, calendars, and
references to artifacts, bots, and tasks, with each person's sidebar order on the nested member record. Heads and
immutable revisions live in module-owned AgentKV storage; document change logs live in their own
tables beside it.

```text
HTTP / model tools -> SurfacesModule -> one composing database transaction
                                      |- head + immutable revision
                                      `- Durable Functions notification -> API journal
```

The transaction lock serializes compare-version-and-write, fractional ordering, and membership
changes across lists. History pagination selects only a bounded prefix range. Durable tools use
Agent Base's transactional settlement; image creation retains a call-stable ID and image bytes.
The admin tools check active admin authority at selection and execution. Images pass through
Compute's filesystem boundary and bounded managed normalization, never an arbitrary served path.

Separators are withdrawn. Rows an earlier daemon stored stay untouched, but the catalog read
filters them out, so listing, membership, ordering, content routes, and chats all treat their IDs
as not found, and a creation request reusing one is refused rather than echoing it back.

Document Surfaces are Yjs documents edited with BlockNote. `documents/` owns them: every accepted
change is appended to a permanent log with its `seq`, actor, source, and mutation ID, and the head
and periodic snapshots let any version be rebuilt by replaying from the nearest snapshot. Changes
merge, so writes need no version guard; a repeated mutation ID returns its first `seq`. Markdown
is a read-only projection made by converting the Yjs fragment through BlockNote's schema on a
private copy, so content outside that schema is detected and left out instead of deleted. Agent
writes compare their Markdown with the version they read, block by block, and apply only the
difference to the current document inside the write transaction. A document stored as Markdown
by an earlier daemon converts on first touch; its Markdown revisions stay readable.

Live changes and presence ride the API's existing event stream as unjournaled frames. The module
keeps which streams follow which documents in memory and publishes a change only after its
transaction commits; the API checks that a stream belongs to the caller before routing to it.
Ordinary models can read, update, and list changes; only active admin bots create documents.

Calendar Surfaces hold series records, never stored occurrences. `calendar/` owns them: each
event's current record lives in its own table with conservative instant bounds of everything the
series can cover, so a range read filters in SQL before decoding and expands only those events.
Expansion walks local dates in the event's own zone through `Intl`, keeps the wall-clock start
across daylight-saving changes, skips months without the start's day, and numbers occurrences
from the event's own timing. Every change also appends an immutable full revision, and an
earlier state is restored by sending its fields through ordinary update. Tools speak local ISO
8601 date-times with an IANA zone, so models never convert instants or expand repeats.

Reference Surfaces store only an immutable binding to their target beside the shared record.
Every read resolves it against the owning Artifacts, Bots, or Tasks module, so the live name,
image flag, and target version are never copied or synchronized. A missing, deleted, or archived
target reads as unavailable without its ID. Shared events carry the stored record alone, never
the resolved projection. The three admin creation tools share the image and replay handling of
the other typed creation tools.

Every Surface type can own one shared chat, created only when a person opens
it. The request reserves the agent ID, workspace ID, and folder path in `chat.*` and invokes the
durable `surfaces.prepareChat` function in the same transaction. Preparation belongs to the
daemon's lifetime: it makes the folder under Configuration's `Surfaces` root on the task-layout
runner, then creates the parentless agent, writes the agent and workspace indexes, and names the
agent on the Surface in one transaction. The HTTP caller only waits, at most 20 seconds, for that
commit. Tasks, bots, files, terminals, services, bridges, and the API ask this module whether an
agent or workspace belongs to a chat; the Surface, not those catalogs, owns its lifetime. The chat
agent's context names the Surface and receives the ordinary, non-admin Surface tools.
