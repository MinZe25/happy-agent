# MCP module learnings

## Happy owns global and demand-driven workspace catalogs

Parsing MCP entries from general project or provider configuration without installing a production
client lifecycle left servers visible in configuration but unusable by models. MCP configuration
now comes from dedicated `mcp.toml` files: one in the user's config directory and one optionally at
a workspace root. `McpModule` owns SDK clients, transports, child processes, failures, session
demand, and online reconciliation. Provider-specific MCP files are deliberately ignored.

Workspace demand follows durable session lifecycle. The first session in a workspace loads its
catalog; the last archived session releases it, and workspace archival releases it immediately.
Connections are pooled by normalized server configuration across catalogs, so identical entries
share one process and close only after their final catalog reference disappears. User-wide entries
win same-name collisions without starting the shadowed workspace process.

Workspace `mcp.toml` is intentionally treated as trusted project configuration and starts
automatically when a durable session creates demand. Tool allow/deny policy is catalog-local and
does not split otherwise identical pooled processes.

## Invalid tools are isolated from the catalog

An MCP server's tool descriptors are untrusted independently of the connection itself. Validate
each listed tool before assembling a page, omit only descriptors that are invalid or outside the
bounded protocol shape, and keep the server and its healthy tools connected. Model-facing tool
conversion has the same per-tool failure boundary, matching Codex's behavior of logging and
skipping a tool whose spec cannot be built. MCP JSON values permit twelve nested collections;
deeper values remain excluded so validation work stays finite.

## Bounded JSON schemas serialize compactly

The depth-bounded JSON value schema shares one child between its array and record branches at
each of its twelve levels. In memory that is small, but JSON serialization expands the sharing:
one direct tool's result schema was 12 million characters. Claude keyed its live query on
`JSON.stringify` of the tools, so with about sixty MCP tools every turn spent some 25 seconds of
main-thread CPU and each live session kept a 700 MB key, freezing the daemon and growing it to
gigabytes. Each level now serializes as a flat description of its collections, so the
serialized form no longer grows with depth, while TypeBox validation still walks the real levels
and enforces the bound.

## Configuration edits reload through the same bounded path

Model-driven global changes update one named server so unrelated records are preserved, then use
the same serialized reconciliation path as an explicit reload. The reload tool reconciles the
calling workspace by default and the user catalog only with its explicit global flag. New
connections are prepared concurrently, unchanged pooled clients stay live, and obsolete clients
close only after the catalog swap and final-reference check.

Malformed workspace catalogs are isolated from global and healthy-workspace reconciliation. Their
last valid catalog remains live, a new failure is logged once, and a catalog that has never loaded
is retried on later session use. Archival, path reuse, queued reloads, and shutdown all pass through
the same serialized lifecycle boundary so stale work cannot resurrect a released process.

## Stdio servers follow the folder's machine

MCP stdio servers used to be children of the daemon, with a workspace's `mcp.toml` read from the
daemon's disk by path. A runner workspace's path names a folder on another machine, so the daemon
would read a different file, or none, and start the server beside the database instead of beside
the code. A workspace's catalog key now includes its runner, its catalog is read through the
runner's filesystem, and its stdio servers start through the runner's product processes behind a
small stdio transport. Pool keys include the runner for stdio servers. Folders on this machine
keep the SDK's own stdio transport, because it limits the inherited environment to a safe subset,
and the daemon's environment can hold provider credentials; a runner's environment holds none.

## A runner's servers fail while it is away and return with it

A server's stream on a runner survives a reconnect within the runner's lease, so a request sent
while the runner was away waited up to the whole lease, stalling an agent turn for about a minute.
When the lease ran out the server was gone, yet its pooled connection stayed in place, so the server
never came back after the runner restarted. A runner that disconnects now fails its servers at
once with a message naming it and stops them; a connection that ends on its own is recorded as
failed; and the runner's return reloads every failed server.

## Failed servers come back on their own

A server that failed at startup stayed failed until someone ran `reload_mcp_servers`. In the case
that exposed this, a server hung on an expired login after a daemon restart and was marked failed
when its startup timed out. Its tools dropped out of every session, and a long-running Bedrock
session whose native tool search had found one of those tools then failed every request. Each
pooled server now keeps what it took to start it. While a catalog still uses a failed server, the
module retries it in the background, first after one second and then with the delay doubling up
to five minutes. Exactly one retry exists per server, pending or running. The attempt connects
outside the reload lock and adopts the connection only if the server is still failed and still
used. A reload that got there first, a released catalog, or shutdown closes the late connection
instead. The retry is in-memory, like the connections it restores: after a restart, the initial
reload starts every server again, so durable execution would add nothing.

## A bot with its own Linux user gets no shared stdio servers

Stdio servers are pooled per machine, and with `[execution]` the machine is the default workload
user's runner. A bot given a user of its own, typically one that strangers talk to, would otherwise
have driven processes running as the default user, with that user's files. Its agents now see
those servers as failed with a message naming the reason, and connecting refuses; the catalog
records which user each active agent runs as.
