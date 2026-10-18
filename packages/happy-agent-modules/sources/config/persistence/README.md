# Private native account identities

```text
actual CodexSessionCredential.accountId
                 │ exact principal, copied at operation entry
                 ▼
agent.sqlite: happy_agent_config_native_accounts
                 │ random local UUID only
                 ▼
frozen execution account: { id }
```

Config's immutable `001-native-account-identities` migration creates the table before modules
start. The `(family, principal)` primary key and unique random ID belong to this installation,
independent of a provider profile, token or agent. Lookup and creation share `ctx.inTx`, including
the caller's transaction and the database owner's FIFO, so concurrent agents return one identity
and rollback leaves no partial mapping.

The table stores no tokens, token hashes, paths or labels. Principals are bounded to 256 UTF-8 bytes.
At most 4,096 rows are retained, with no eviction: new principals become unknown at capacity, while
existing identities remain stable. Unknown, invalid, cancelled and storage-free observations also
remain unknown. There is no in-memory identity cache, public query, event, export or model tool.
Normal private database backup and restore preserve the mapping alongside history.

An actual database error propagates as a fixed error without SQL parameters or a cause, consistent
with the product's database-failure contract. It prevents that operation from dispatching; it never
silently selects another account. Capacity and missing identity are ordinary unknown provenance,
and do not fail inference.
