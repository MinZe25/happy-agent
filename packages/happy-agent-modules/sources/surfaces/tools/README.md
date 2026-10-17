# Surface model tools

One fixed common array serves every model. Todo operations name their Surface instance and use
current-version guards. A separate fixed admin array adds type-specific creation and user
administration only for actual active admin bots. Every mutation owns its permission policy.

Document tools read the Markdown projection at the latest or an earlier `seq`, write full
replacement Markdown against the `seq` the model read, and list the change log. A write applies
only the difference from that version, so people's concurrent edits survive, and it is refused
with an explanation when the document holds content Markdown cannot represent. Reads skip review;
writes require shared-data Auto review without filesystem elevation. Document creation has the
same optional managed-image boundary as todo creation.

Calendar tools live in their own fixed array merged into the common one. They read and write
timed values as local ISO 8601 date-times in an IANA zone, list occurrences the daemon expanded,
and restore history through ordinary update. Admin bots also receive `create_calendar_surface`.

Admin bots receive `create_artifact_surface`, `create_bot_surface`, and `create_task_surface`.
Each names its own target field, requires an explicit creator, and accepts an optional image.
They reject missing or inactive targets as not found and never change the target's own access,
membership, or catalog.
