# Scheduling learnings

## A bot's reach is checked when a message is scheduled and again when it is due

A scheduled message is a promise to reach another agent later, so it is a way around a bot that
keeps its agents inside its own tree. Checking only at scheduling time would let a message promised
before the bot was restricted go out after it. The bot settings module is asked both when the
message is scheduled, which refuses it to the sender at once, and when it falls due, which leaves
it undelivered with the refusal as its failure. Messages to the sender itself and inside the bot's
tree are unaffected.
