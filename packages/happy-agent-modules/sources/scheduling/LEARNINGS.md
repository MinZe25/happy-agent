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

## A bot's reach is checked when a message is scheduled and again when it is due

A scheduled message is a promise to reach another agent later, so it is a way around a bot that
keeps its agents inside its own tree. Checking only at scheduling time would let a message promised
before the bot was restricted go out after it. The bot settings module is asked both when the
message is scheduled, which refuses it to the sender at once, and when it falls due, which leaves
it undelivered with the refusal as its failure. Messages to the sender itself and inside the bot's
tree are unaffected.
