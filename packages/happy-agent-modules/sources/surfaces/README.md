# Surfaces

Shared typed feature instances, initially todo lists, with each person's sidebar order on the
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
