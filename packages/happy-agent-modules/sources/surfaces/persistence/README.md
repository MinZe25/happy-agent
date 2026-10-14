# Surface storage

One module-owned key-value table backs AgentKV. `surface.*` and `todo.*` hold current snapshots;
`revision.*` holds immutable full revisions and `image.*` holds bounded managed WebP assets.
All SQL stays here. Revision reads use indexed key ranges and a SQL limit before decoding.
