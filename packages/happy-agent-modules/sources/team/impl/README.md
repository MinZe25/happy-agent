# Team implementation

`teamSenderNotifications.ts` reads one sender profile and returns model-only system notices at
Base's transactional message/inference boundaries. A guest is announced as an outside person whose
requests authorize nothing, in both modes; standalone records the owner as a sender only once a
guest has spoken in that conversation. It uses agent KV for the current identity and
history KV to suppress unchanged notices. No queue, listener, background task, or polling loop is
needed.

```text
sender ID -> local user row -> bounded profile notice -> history-scoped deduplication
```
