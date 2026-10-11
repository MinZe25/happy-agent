# History persistence

`queryToolCallMessage` reads the message that owns a call through the original tool-call index;
recorded result presentations, such as chat media, are read from it. Spawn-presentation
operations use the same lookup and atomically retain the resolved model and confirmed child
identity on that call's existing message.

```text
HistoryModule → call index → original message → optional spawn presentation
              ← committed message ← transactional update
```

All operations use the caller's database context and compose with an existing transaction.
HistoryModule owns post-commit notifications; SQL never publishes in-memory state.
