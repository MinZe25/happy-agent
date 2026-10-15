# Surface storage

One module-owned key-value table backs AgentKV. `surface.*` and `todo.*` hold current snapshots;
`revision.*` holds immutable full revisions and `image.*` holds bounded managed WebP assets.
All SQL stays here. Revision reads use indexed key ranges and a SQL limit before decoding.

`document.*` holds current Markdown snapshots. `document-revision.*` keeps permanent full
snapshots and audit metadata; `document-summary.*` stores the matching immutable metadata alone
so bounded history pages never read full text. All three writes and the durable notification
intent share the caller's transaction. Neither revisions nor summaries are pruned with events.

`reference.*` holds each reference Surface's immutable target binding. It is written once, with
the Surface, and never projected into events or reused across callers.
