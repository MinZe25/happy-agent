# Surfaces

Shared typed feature instances, including todo lists, Markdown documents, and references to
artifacts, bots, and tasks, with each person's sidebar order on the nested member record. All heads and immutable revisions live in module-owned AgentKV storage.

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

Document Surfaces keep a separately versioned current snapshot and permanent full revisions.
Guarded replacements, including clearing or applying historical text, never change the catalog
version. History listing reads a bounded range of separately stored metadata summaries, not full
document text. Every revision retains its actor, source, and immutable mutation ID for uncertain-save
recovery. Ordinary models can read, update, and list versions; only active admin bots create them.

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
