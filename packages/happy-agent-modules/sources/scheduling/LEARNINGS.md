# Scheduling learnings

## Wait state belongs to Scheduling

Desktop lists previously had no authoritative interval and reconstructed waiting from running
tool calls. Scheduling now exposes its earliest active durable interval and includes `activeWait`
in wait events only when that interval changes. The indexed query filters active rows before
reading one record, so terminal history never becomes catalog work. Concurrent waits replace
the interval as each earliest wait ends; durable replay emits no duplicate interval change.

Graceful shutdown used to interrupt steerable waits and commit a terminal result, losing the
original interval before restart. The wait tools are now reloadable, and Scheduling leaves the
waiting row intact when the shared shutdown coordinator is stopping the daemon. Explicit abort,
archival, and new messages still settle and clear the wait normally.

## A wait is live only while its tool call is

Desktop showed "Wait ending" through later turns after the agent had moved on, because `waiting`
rows outlived their calls and the active interval kept reporting them. The common cause was a
steering message interrupting a fresh wait: the interruption ends the call's lifetime, the wait
then settled on that same call context, and agent storage refuses a context whose work has ended
("The store cannot be used…"). The settle failed, the error became the call's answer, and the row
stayed `waiting` forever. As the earliest interval, an orphan also hid later waits' changes.
Shutdown could orphan a row the same way, since it ends every root-derived lifetime before agents
reach their reload edge.

Three rules now hold. A wait settles on the module's own long-lived context, never on the call's.
Any answer Agent Base commits for a wait's call settles that wait in the same transaction
(`afterToolCallTransact`), so an abort, close, or error answer cannot leave it behind. When an agent
is restored at start, before its loop runs, every row it left `waiting` becomes `suspended`: a
suspended row is never the active interval, the replayed call resumes its own row with the original
interval, and an orphan whose call never returns stays out of the projection. Recovery runs in
`agentRestoredTransact` rather than `beforeStart` because modules start concurrently, and the
interval change it announces must not reach the API before the event journal has loaded.

## A bot's reach is checked when a message is scheduled and again when it is due

A scheduled message is a promise to reach another agent later, so it is a way around a bot that
keeps its agents inside its own tree. Checking only at scheduling time would let a message promised
before the bot was restricted go out after it. The bot settings module is asked both when the
message is scheduled, which refuses it to the sender at once, and when it falls due, which leaves
it undelivered with the refusal as its failure. Messages to the sender itself and inside the bot's
tree are unaffected.
