# Surfaces

Shared typed feature instances, including todo lists, Markdown documents, and contentless sidebar separators, with each person's sidebar order on the
nested member record. All heads and immutable revisions live in module-owned AgentKV storage.

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

Separators reuse catalog creation, members, ordering, and durable events. They never accept an
image or todo content, and the admin-only `create_separator_surface` tool has no filesystem access.

Document Surfaces keep a separately versioned current snapshot and permanent full revisions.
Guarded replacements, including clearing or applying historical text, never change the catalog
version. History listing reads a bounded range of separately stored metadata summaries, not full
document text. Every revision retains its actor, source, and immutable mutation ID for uncertain-save
recovery. Ordinary models can read, update, and list versions; only active admin bots create them.
