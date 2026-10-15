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

`chat.*` holds each Surface chat's reservation: the agent ID, workspace ID, folder path, runner,
and the winning request's mutation ID, written once before any filesystem work. `chat-agent.*`
and `chat-workspace.*` index the committed chat by its agent and its workspace. They are written
only with the Surface's `chatAgentId`, so a pending reservation is never reported as a chat.
