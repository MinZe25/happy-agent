# Desktop Live

`LiveModule(ConfigModule, DurableFunctionsModule, BotsModule)` owns window-scoped voice sessions
and the machine's voice settings. The browser
owns WebRTC media; this module owns one credential-selected provider call, its sideband, durable
status, a typed desktop control socket, and bounded side inference. It never creates a coding agent.

[GPT-Live context-management research](research/gpt-live-context-management.md) records source links, verification limits and sidebar hypotheses.

The text controller runs the `[voice]` settings: `controller_provider`, `controller_model`,
`controller_effort` and `controller_fast_mode`, defaulting to GPT-6.1 Sol at low effort on the
configured default account, with fast mode off. `ConfigModule` stores runtime changes in generated
`runtime.toml`, which overrides the machine file, and resolves the route; this module reports them
as `config.voice`, applies `PATCH /v0/config` voice changes for the API, and gives active admin bots
`get_voice_settings` and `set_voice_settings`. `system_prompt` replaces the voice model's built-in
prompt; the built-in prompt is never stored. A pool chooses one enabled compatible account at startup
and keeps it for the entire call, without account rotation or failover. Route, effort, service tier
(priority only when fast mode is on and the route offers it) and voice prompt are frozen per call. Voice separately uses the explicitly selected official OpenAI API key
or Codex subscription credential. There is no credential, account, model, or old-Realtime fallback.
Native credentials are reloaded once from the selected provider-owned sign-in store before the
single allocation; a rejected sign-in never triggers another allocation or an OAuth refresh here.
Controller and credential setup failures have separate sanitized explanations. Selecting an
account pool as the voice credential reports that an individual OpenAI account is required.

A failed controller delegation returns a bounded safe explanation to voice and leaves the call
active for the next request. An uncertain action is never retried; its identity remains remembered
and late results are ignored. Connection/protocol loss, account disablement, response delivery failure,
and the lifetime action limit still end the call. Categorized diagnostics exclude provider text.

Local diagnostics are on at the default `info` log level in
`~/.happy/agent/observation/agent.log` (replace `~/.happy` with `HAPPY_HOME_DIR` when set).
Filter JSON lines by `module: "live"` and `voiceSessionId`; the `msg` field contains a JSON
metadata record with an `event`, desktop context revision, elapsed time, and suppressed count.
Records describe lifecycle, frozen model routing, accepted desktop IDs and counts, selected
session snapshots, delegations, actions and results, and fixed failure categories and phases.
They exclude transcript and message text, composer contents, names and titles, audio, SDP,
credentials, and raw errors. Frequent context,
transcript, and snapshot records are limited to ten per second per kind and 1,024 combined per
call; action and delegation diagnostics follow Live's existing lifetime limits. Each metadata
record is at most 32 KiB. Observation keeps the current log and one previous generation,
with a bounded write queue; Unix log files are readable only by their owner. Logs respect
the existing observation settings, including disabling logs or selecting a higher log level.

The fixed controller tool arrays and literal model prompts live in `impl/runLiveController.ts` and
`impl/livePrompts.ts`. A call merges the base array with `LIVE_TASK_CREATE_TOOLS` and
`LIVE_MODEL_CHANGE_TOOLS` only when the desktop negotiated `taskCreate` and `sessionModelChange`
(both require `appState`). `sessionSend` and `composerDraftAppend` name their conversation; when it
is not focused, the daemon first requests `desktopOpen` for it and stages only after that open
succeeds. One controller response may batch up to four actions; they run in order, each on the
latest accepted revision, and stop at the first that does not succeed. When every action
succeeded and all were terminal (open, staging, draft append, model change, task creation), voice
receives a fixed outcome from `impl/liveOutcome.ts` without a second inference. Desktop context, provider fragments, selected public session snapshots and
native delegation text enter a JSON data envelope, never a trusted instruction or authorization.
`sessionSend` ends after exact text staging; only a separate human Send submits it.

Each call owns one logical controller conversation and lazily opens one provider session. Follow-ups
queue in arrival order. Completed history contains only attributed request text and the exact
spoken outcome; tools, results, reasoning, and provider metadata remain transient within one
request. Subsequent requests replace the provider context with that text history, preserving the
connection while giving up continuation from the previous response. An unsettled aborted stream
is retired after bounded cleanup; only a new request may open a replacement with the same history
and frozen route. Failed requests and uncertain actions are never replayed.

Voice receives `# Desktop AppState` Markdown (`impl/liveAppState.ts`): the focused path, each
server in the desktop's order with its top-level bots and tasks and its projects, workspaces and
direct conversations as `Name — Status — last activity <time>` in the desktop's time zone, and the
focused conversation's latest public message clipped at 800 bytes. With the `appState` capability the
desktop sends AppState as its own unrevisioned frame; otherwise the same format is derived from the
accepted context. Startup is bounded to 8 KiB with an explicit omission marker. Later changes are
`# Desktop AppState update` diffs, coalesced for 250 milliseconds with one push in flight and split
into labelled appends of at most 500 bytes rather than truncated. A complete snapshot is pushed again
after ten minutes without one. Pushes and status notices wait while a request lacks its delivered
outcome. With `voiceFocus`, the daemon highlights a uniquely named target before the controller runs
and before each targeted action, and clears it when the request ends. Missing or deeper content
is read through the controller. Native background snapshot frames omit the optional channel.
Snapshots and selected-session updates are facts, not requests or orders to speak. Voice may choose
a brief, relevant notice for a verified focused or explicitly watched conversation's completion,
error, or need for input. Routine navigation needs no acknowledgment. Existing status transitions
identify completion only after running or waiting; newly selecting an idle conversation does not.
Repeated notices and unnecessary interruptions are discouraged; silence is not a transport guarantee.

## Lifecycle

Reservation and durable startup intent commit together. Allocation runs once after commit and
returns SDP after sideband attachment, before browser negotiation. Active status requires a real
provider readiness event. Interrupted startup and restart fail without replay. Call allocation and
attachment share 30 seconds; readiness has another 30 seconds; desktop control must attach within
15 seconds after allocation. Four nonterminal calls per principal and one per window are allowed.

Public close waits at most 15 seconds for an actual terminal event and final usage. Only a requested
`close_requested` event is an orderly end. Native close sends the native command then closes the
socket, with no fabricated final usage. Closing voice never closes coding tasks. Terminal records
are retained seven days, at most 1,000 per principal. Only owner-filtered status reaches the journal.

Control frames are at most 256 KiB. At most 256 action identities remain for the call's lifetime,
and the call permits one outstanding desktop action with a 60-second deadline starting at dispatch.
Requests take fresh compact context when their queued turn starts and retain their original
speech attribution. Each request has a hard 120-second deadline, including provider stream
iteration, followed by at most three seconds of cleanup. Provider response frames retain atomic
append ordering, with a 30-second limit for each socket write; stalled delivery ends the broken
transport without replay. Uncertain actions are not replayed.
Queued requests expire after 120 seconds without starting an action. Controller history and the
active exchange are bounded to 512 KiB; a request that cannot fit fails clearly while voice stays
open, without silently trimming history. Context revisions are immutable; selected public snapshots
remain separate and bounded. Protocol or action-ledger overflow ends voice visibly.
Native and public append framing, transcript timing, and close semantics remain
separate in `impl/liveProviderTransport.ts`.

The public [Live event reference](https://developers.openai.com/api/reference/resources/live/)
requires numeric `start_ms` and `end_ms`. Exact integer intervals are forwarded; valid fractional
intervals use the approved untimed fragment variant because the desktop contract accepts integer
milliseconds and forbids invented timing. Thus a provider sending only fractional intervals will
produce only untimed fragments. Native transcript items are also untimed. Display deduplication
evicts old keys; it does not limit call length. Full streaming snapshots stay out of voice context;
short status summaries are best-effort, and overlapping delegations never produce a busy refusal.

## Verification

The Live module, controller, configuration and provider transport tests are targeted unit coverage.
`tests/runtime/liveDesktopTransport.test.ts` uses the complete runtime and real HTTP/WebSockets with
scripted provider inference. It can export its sanitized actual controller request through the
test-only `HAPPY_LIVE_CAPTURE_FILE` environment variable. Bun transport smoke coverage lives in
the Agent package; targeted API gym scenarios live in `packages/happy-agent-gym-tests/tests/happy_api_live.test.ts`.
These fixtures do not prove microphone/media negotiation or account entitlement against OpenAI.

A real native audio call, before voice v2, verified one Luna LOW provider session across two requests, text-only
retained history, sequential navigation and staging, and exactly one submission after human Send.
The same call failed both quiet navigation checks: channel-less snapshots produced unrequested
speech. The complete append timeline excluded separate speakable status notifications in those
intervals. Those failures remain recorded. The user subsequently chose proactive background facts
with model discretion over useful notices; current acceptance evaluates relevance and truthfulness,
rather than the former zero-audio gate. This does not establish native hard silence or constitute
completed voice release validation. Live queued overlap and
extra calls in one reply remain covered by deterministic fixtures, rather than that audio call.

A subsequent real call passed the new policy case: routine navigation produced no speech, and an
explicitly requested completion notice followed the real coding agent's completed run, focused
running-to-idle update, and speakable status candidate. Human Send submitted once while voice was
active, and End closed the call. This observes a useful, truthful model choice without guaranteeing
silence or a notice for every background update.
