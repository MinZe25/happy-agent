# Master plan 26: voice

## Big picture

Voice is a spoken conversation with one desktop window. GPT-Live carries the
audio. It has no direct tools of its own, so it hands requests to the
application through client delegation.

Each call has one controller. It is a single GPT-6 Luna session at low effort
on the existing Codex account. Requests keep being added to that one session,
and it acts by calling a fixed set of desktop tools that the client executes.
A call therefore has exactly two conversations, GPT-Live and the controller.
There are never several controllers, and never a new controller per request.

## One controller, a queue, never busy

A request that arrives while the controller is working waits in a queue. Voice
never refuses it as busy. Requests run one at a time in the order they
arrived, and the desktop still receives one action at a time.

## Context

Latency is cut in two ways, and we want both:

- compact AppState is pushed to the voice model;
- the controller answers through tools.

When the call starts, push a snapshot of the most recently active work and the
entire sidebar, with top-level bots first. Deeper levels are read only when
needed: the subtasks inside a session or bot, and then a particular subtree.

Only text messages from the user and from the assistant are pushed. Tool calls
and tool results are not: they are noise most of the time. This covers context
sent to the voice model, conversation context imported from the app, and the
controller's own history between requests. Tool calls and results exist only
while the controller is working on a request.

Resetting context once in a while is deferred.

## Names, not IDs

Speech uses names, such as the names of sessions and bots. IDs stay internal
and are used for targeting.

## Prompt and effort

The voice model's system prompt follows OpenAI's example prompt for GPT-Live.
GPT-Live documents no reasoning-effort setting for the voice model, so effort
is set only on the controller.

## Not now

- The Decisions API is not used.
- An OpenAI API key will come later. Until then, voice uses the existing Codex
  account and adds no new billing.

## Order and criteria

1. Build one controller per call with its queue, so no request is refused as
   busy and the desktop never has two actions outstanding.
2. Push the compact AppState snapshot at call start, and keep only user and
   assistant text between requests.
3. Verify with real calls in which Luna calls tools. Opus 5.5 reviews the
   change, cuts and improves it, and has the final say.

This plan is done when:

- every call has exactly one controller conversation, and follow-ups are
  queued instead of refused as busy;
- from the start of the call, voice knows the most recently active work and
  the top level of the sidebar, bots first, and reads deeper only on demand;
- only user and assistant text is pushed or retained between requests;
- speech refers to sessions and bots by name;
- a real call in which Luna calls tools in two requests has passed, and Opus
  5.5 has signed off.
