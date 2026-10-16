# GPT-Live context management: what builders are doing

Research date: 10 October 2026. Read-only web and X research. No product code was changed.

This document discusses the published public GPT-Live API. Happy's Codex native transport
separately uses `session.context.append`; the absence of that name from public documentation
does not establish that the native event is invalid. Thinking updates carry background facts,
but do not guarantee silence: Happy's retained native calls produced speech after channel-less
updates. The sidebar suggestions below are hypotheses, not product requirements or implemented changes.

How to read the labels:

- **Fetched.** The page was retrieved in this pass. Some long pages were cut off before the end, and that is called out where it matters.
- **Search-cited.** A web or X search returned the link and a summary. The tweet page or the later part of a doc was not opened in full, so wording is a summary, not a quotation. These claims were not independently verified against the complete source.
- **Hypothesis.** An inference for the sidebar app. Not something a builder posted.

There is no published public event named `session.context.append` in the sources reviewed.
Public context updates during a call use three append events: `session.instructions.append`,
`session.thinking.append`, and `session.commentary.append`.

## 1. Core approaches

- **Three channels, not one context blob.** Trusted behavior goes in instructions. Background facts go in thinking. Text the model should say goes in commentary. Each append is a plain string of at most 500 tokens and needs a `delegation_id` (`null` for the whole session, or a client-delegation id for one task). An `*.appended` acknowledgement means the update was accepted for injection, not that the model used it or said it. **Fetched** from the session guide.
- **Startup is the only place for a real history load.** `instructions` (up to 16,384 tokens) stay for the life of the session. `session.input` takes up to 128 prior text messages and 8,192 combined tokens. After start, history is append-only: you cannot edit or delete an item. **Fetched** (OpenAI session guide; LiveKit plugin states the same append-only rule).
- **UI state is a short prose summary, pushed on real changes.** The delegation guide’s “Share UI context” section says to build a short summary of the current page or task and of selections from application state, with no extra model call. Send it at start and when state actually changes. Skip unchanged updates. Collapse a burst of changes into one summary of the latest state. Say corrections explicitly (“now 8 PM; it was 7 PM”). Use `session.thinking.append` with `delegation_id: null`. Keep HTML, DOM, large JSON, and logs in the app. Treat page text as data, not instructions. **Search-cited** against the official delegation URL; that heading was past the truncation point of the page fetch.
- **The app, not the voice model, owns durable state.** GPT-Live summarizes older history in the background and stays in the same session. Older details can be dropped, so confirmed facts and task state should live in the app and be supplied again when needed. Justin Uberti has described async compaction that prefills a new instance and switches without stalling the call. **Fetched** (Microsoft Foundry concept page). **Search-cited** (Uberti compaction post; calendar date not returned).
- **Client delegation means you choose what the text model sees.** The delegation event is metadata only (an id and a target), not a task description. You infer the task from transcript deltas plus app state. Responses delegation lets GPT-Live pass conversation context to a Responses model (docs currently point at `gpt-6-luna` or `gpt-6-sol`) and you still run function tools. Mode is fixed for the session. **Fetched.**
- **Builders keep the agenda and the tools outside the voice model.** Phone agents append short instruction frames from a backend state machine (Victor Billaud). call4me gives GPT-Live no tools and lets a Responses “back office” own `press_digits`, `ask_user`, and `end_call`, then watches the transcript with regexes when the model says it will act and does not. **Search-cited** (Billaud, call4me writeup). **Fetched** (call4me README for the tool split and menu recovery).
- **Background updates versus speech.** Inventory and progress that need no spoken announcement go through thinking. Commentary is for something to say, and the model may paraphrase it. Instructions can steer immediately and, in production phone agents, often cut off current speech or start new speech if the model was silent. **Fetched** (channel definitions). **Search-cited** (Guillem, 8–9 Oct 2026). None of these channel descriptions establishes a hard silence guarantee.
- **Latency levers that showed up in docs, not as a rich X thread.** Set `delegation.responses.service_tier` to `"priority"` for the backend. Do not delegate when the answer is already in the conversation. A concise tool result does not need a second model call to rewrite it for speech (quoted by Desh Raj from the delegation guide). Reconnects in LiveKit resend history under the same 128 / 8,192 cap rather than growing a second context. **Fetched** (priority tier, LiveKit `max_session_duration`, Desh’s quotation). No X thread in this pass described prewarming a GPT-Live socket.
- **Gotchas people are actually hitting.** `session.commentary.append` can stay silent and then error with `context_injection_incomplete` after tools finish (Nick Prince, 22 Sep 2026). Long compiles go stale unless new results are pushed (Sebastian Sosa). Voice still feels “dumber” than a text thread, and some builders keep a Codex or cascade thread as the real context and treat voice as a side channel (Jordan Schenck, Don Park). Thinking context is not a secrecy boundary. **Search-cited**, except the secrecy warning, which is in the fetched session guide.

## 2. Sources

### Official and platform docs

**OpenAI, “Managing GPT-Live sessions.”** Undated page, fetched 10 Oct 2026.
https://developers.openai.com/api/docs/guides/live-conversations
https://developers.openai.com/api/docs/guides/live-conversations.md
**Fetched.** Startup `instructions` and `input`; the three append events; 500-token plain strings; `delegation_id`; acknowledgement timing (`start_ms` / `end_ms` on the session timeline, not on playback); pending appends error if the session closes; the model may repeat anything you append, so secrets stay in the backend. UI changes are pointed at “Share UI context.”

**OpenAI, “Delegation and tools in GPT-Live.”** Undated page, fetched 10 Oct 2026 (truncated before the Share UI section).
https://developers.openai.com/api/docs/guides/live-delegation
https://developers.openai.com/api/docs/guides/live-delegation.md
**Fetched** for mode choice, Responses config (`gpt-6-luna` / `gpt-6-sol`, tools, `service_tier: "priority"`), and the rule that client delegation requires the app to keep conversation context. **Search-cited** for Share UI context: short summary, send at start and on change, skip unchanged, collapse bursts, explicit corrections, `session.thinking.append` with `delegation_id: null`, no HTML/DOM/large JSON. https://developers.openai.com/api/docs/guides/live-delegation#share-ui-context

**OpenAI, “Prompting GPT-Live.”** Fetched 10 Oct 2026.
https://developers.openai.com/api/docs/guides/live-prompting.md
**Fetched.** Voice prompt holds role, backchannels, interruptions, and a delegation policy (when to delegate and when not to). Backend instructions hold the procedure. Commentary appends are how you feed spoken progress while work runs. Do not guess a result while waiting. Reuse a still-current backend result instead of calling again.

**OpenAI, “Connect voice to Decisions.”** Fetched 10 Oct 2026.
https://developers.openai.com/api/docs/guides/decisions-voice
**Fetched.** The closest official pattern to “snapshot plus a fast text model.” Client delegation. The Decisions prompt is plain text: recent transcript, last user request, and current state (example: active tab and available actions). Model in the example is `gpt-6-luna`. The app runs the choice only if it still fits current state, then returns a spoken result with `session.commentary.append` and the saved delegation id. Quiet updates use `session.thinking.append`. Same 500-token cap. A heavier request can be routed to a reasoning Responses call with the original request and the relevant slice of state, still under the same client-delegation id.

**OpenAI launch and architecture posts.** Not fetched (the architecture URL returned HTTP 403).
https://openai.com/index/introducing-gpt-live-1-in-the-api/
https://openai.com/index/continuous-voice-interaction-with-gpt-live/
**Search-cited.** Used only as pointers. Do not treat unrecovered sentences from these pages as findings.

**Microsoft Foundry, “What is GPT-Live?”** Page date 4 Sep 2026, updated 30 Sep 2026. Fetched.
https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/gpt-live
**Fetched.** Automatic context management. Startup instructions are preserved. Near the window limit the service summarizes older history in the background and continues the same session. Keep important facts and task state in the app. Speech and backend work are independent: interrupting speech does not cancel a tool, and a finished tool does not mean the user heard the answer. Voice minutes and backend tokens are billed separately.

**LiveKit, “OpenAI GPT-Live plugin.”** Fetched 10 Oct 2026 (truncated in the tools section).
https://docs.livekit.io/agents/models/realtime/plugins/gpt-live
**Fetched.** Append-only context. Voice instructions and backend instructions are separate and cannot be replaced after start; the plugin errors if you try. `max_session_duration` opens a new connection and sends the conversation again. Default delegation is Responses. **Search-cited** for the later “Conversation context” section: startup `chat_ctx` maps to `session.input` with the 128-message / 8,192-token cap (oldest dropped first); `appendThinking` does not enter `session.history`; appends queue and return without waiting; a handoff that changes instructions opens a new session and resends history under the same cap.

**LiveKit JS session class (methods only).** Search-cited, not fetched in full.
https://docs.livekit.io/reference/agents-js/classes/plugins_agents_plugin_openai.realtime.GPTLiveSession.html

### X / Twitter

Tweet bodies were not opened. Summaries are what X search returned. Dates are included only when the search stated them.

**Justin Uberti (@juberti), OpenAI Realtime.** 8 Oct 2026.
https://x.com/juberti/status/2108315461582725269
**Search-cited.** `session.instructions.append` steers a Live session and takes effect immediately. He pointed at the Live WebSocket docs. This was a reply to Jesse Ezell asking whether Realtime would get the same steering as Responses: https://x.com/jezell/status/2108283502177276205

**Justin Uberti (@juberti).** Calendar date not returned.
https://x.com/juberti/status/2098146525029474369
**Search-cited.** The realtime model keeps talking while delegation runs in the background and context streams in.

**Justin Uberti (@juberti).** Calendar date not returned.
https://x.com/juberti/status/2084389548935553107
**Search-cited.** Long-context calls use async compaction: near the limit, compaction starts in the background, a new instance is prefilled, and the call switches over without stalling.

**Guillem (@guillem_dev).** 8–9 Oct 2026, in the Uberti thread.
https://x.com/guillem_dev/status/2108334010019750303
https://x.com/guillem_dev/status/2108476579575935260
https://x.com/guillem_dev/status/2108476952239849490
**Search-cited.** Phone agents (Catalan/Spanish and other languages). `session.instructions.append` usually cuts off the assistant’s current speech. If the model is silent, it starts new speech or restarts the conversation, even when the instruction says not to. They want a language correction (“use X from your next reply”) to land on the next natural turn. Theme: injection side effects.

**Victor Billaud (@k0nOO).** 8–9 Oct 2026.
https://x.com/k0nOO/status/2108320625312071720
https://x.com/k0nOO/status/2108201778361610460
**Search-cited.** A phone system-design interviewer on GPT-Live. A backend appends short frames so the session holds an agenda. The model is good at the next sentence and bad at knowing where it is in a script, so stages stay outside it. Appending while the user is speaking behaves differently from appending while the model is talking. He asked for timing guidance and, in the search result, got no public answer. Theme: external agenda, short instruction frames.

Related posts from the same author, less about context, same search pass: barge-in should be a state rather than a one-shot (a cough or “yeah” should not kill the question), and interruption rate misses long silences.
https://x.com/k0nOO/status/2108604490601681054
https://x.com/k0nOO/status/2108625256537567241
https://x.com/k0nOO/status/2108188913617485939
https://x.com/k0nOO/status/2108653805847924807

**Nick Khami (@skeptrune), call4me.** Writeup dated 2 Oct 2026 by web search. Product Hunt note 8 Oct 2026.
https://x.com/skeptrune/status/2106086714175570205
https://x.com/skeptrune/status/2106100535292252669
https://x.com/skeptrune/status/2108230748629356845
https://github.com/skeptrunedev/call4me
https://raw.githubusercontent.com/skeptrunedev/call4me/main/README.md
**Search-cited** for the thread. **Fetched** for the README. GPT-Live has no tools. Telnyx PCMU audio is relayed into `gpt-live-1`. A Responses back office owns `end_call`, `ask_user`, and `press_digits`. Prompts follow OpenAI’s three delegation labels. The voice model often says it will press a key or check something without emitting a delegation; the session watches the transcript with regexes and, after a short quiet period (search said about 3 seconds on a menu, about 1.5 seconds on a spoken promise), starts the back office itself. Menu recovery tracks fresh menu speech apart from transcript timestamps and will not blindly replay a dead DTMF route. After hangup, a recap from the transcript is written back into the coding agent’s context. The search summary of the thread says the back office is told to write almost nothing because anything it writes can be spoken; that sentence was not in the README portion that was fetched. Theme: voice decides when to hand off; a text model plus tools owns actions; transcript is a verification channel, not the only one.

**@livetab\_.** Calendar date not returned. Reply under the call4me writeup.
https://x.com/livetab_/status/2106096056064991355
**Search-cited.** Watch how often the “said it would act, but no delegation” fallback fires when gpt-live-1 gets a new snapshot. Theme: snapshot changes behavior, so measure it.

**Nick Prince (@Nickprince).** 22 Sep 2026.
https://x.com/Nickprince/status/2102276552784568744
**Search-cited.** Responses delegation finishes three tools and returns the answer, but Live emits no follow-up audio. `session.commentary.append` is also silent, then `context_injection_incomplete`. Theme: injection failure after tools.

**@heybackchannel.** Calendar date not returned.
https://x.com/heybackchannel/status/2107815706205077614
**Search-cited.** Restates the Decisions guide: GPT-Live keeps talking while the app sends transcripts and current state, runs the action, and feeds the result back into the same session (page reload, slides, media, gestures). Theme: state snapshot beside the transcript. Not an independent implementation writeup.

**Sebastian Sosa (@Sebasti54919704) and ZeroX (@dxiaolong).** Calendar dates not returned.
https://x.com/dxiaolong/status/2098669458135146929
https://x.com/Sebasti54919704/status/2098670716711326099
**Search-cited.** “Full-Duplex Code”: GPT-Live-1 beside a headed Claude Code session. Quiet compiles can be answered from context already in the session. New results need a fresh push. Long-run freshness is not guaranteed. Theme: push on new facts; do not trust the live window across a long silent job.

**Sebastian Sosa (@Sebasti54919704), on someone else’s note.** Calendar date not returned.
https://x.com/Sebasti54919704/status/2103883286254862592
**Search-cited.** He calls “live notes vs pinned brief” a clean fix for stale context. The pattern itself is from @Rajath_DB (https://x.com/Rajath_DB/status/2103878671530353055) and that post is about a Claude Code phone agent, not a confirmed GPT-Live implementation. Do not treat it as a GPT-Live API recipe. The idea (ephemeral notes that expire, plus a rewritten pinned brief of facts) is still relevant as a **hypothesis** for what to put in thinking appends.

**Jordan Schenck (@jordanschenck).** Calendar date not returned.
https://x.com/jordanschenck/status/2106847832263291040
**Search-cited.** Calls the Live context window poor. He rebuilt GPT voice in his own app so a Codex thread does the reasoning. Theme: keep the long context in a text session; voice is the mouth.

**Don Park (@donpark).** Calendar dates not returned.
https://x.com/donpark/status/2105832230702755997
https://x.com/donpark/status/2106119258338124097
**Search-cited.** Prefers a streaming cascade with managed context and voice as a side channel, so every agent can still have a full voice UI. Says his idfon 0.7 build (VAD, AEC, barge-in) feels more fluid than GPT-Live-1. Theme: leave GPT-Live when you need to own the context window yourself.

**@lolfe12.** Calendar date not returned.
https://x.com/lolfe12/status/2108352370090664344
**Search-cited.** One user says GPT Live 1 is roughly a two-hour context window. Anecdote, not a documented limit.

**@anshjain232.** Calendar date not returned.
https://x.com/anshjain232/status/2106976800169513127
**Search-cited.** Voice chats feel much dumber than text threads; wants better in-memory context. Complaint, not a technique.

**Peter Bakkum (@pbbakkum).** Calendar date not returned.
https://x.com/pbbakkum/status/2107570826849714663
**Search-cited.** Recommends gpt-live-1 for personal-assistant voice layers because duplex plus delegation is ahead of other API voice models. Not a context recipe.

**@floinkus.** Calendar date not returned.
https://x.com/floinkus/status/2108606929865941317
**Search-cited.** Pauses, affirmations, and length feel baked into the weights, but the model is still expensive. Theme: cost, not context format.

**LiveAvatar (@TryLiveAvatar).** Calendar date not returned.
https://x.com/TryLiveAvatar/status/2108226188653330550
**Search-cited.** Product note: pick model, voice, and context on your own key. No format details.

### Essays and code that X discussion pointed at

**Desh Raj, “Dissecting GPT-Live.”** 11 Sep 2026. Fetched (cut off in the latency section).
https://desh2608.github.io/2026-09-11-dissecting-gpt-live/
**Fetched.** Client delegation sends no task text. Results return through the three appends, each capped at 500 tokens. UI context is a concise text summary of the current page; images and exact typed values go to the backend, not the voice model. He quotes the delegation guide: a concise tool result does not need another model call to rewrite it for speech. He reads `session.thinking.append` as evidence that the frontend has a reasoning stream separate from user and agent transcripts. His training and chunk-size notes are marked as guesses on the page; they are not used here.

**call4me server prompt.** Not fetched in this pass. Search-cited only.
https://github.com/skeptrunedev/call4me/blob/main/src/server/voice/prompt.ts

**LiveKit example agent.** Not fetched in this pass. Search-cited only.
https://github.com/livekit/agents/blob/aa0d3d35/examples/voice_agents/gpt-live/gpt_live_agent.py

## 3. What applies to a desktop sidebar (servers, bots, sessions) plus a fast text model

This section is **hypothesis**, built only from the patterns above. It is not a claim that someone has shipped this exact app.

**Put the inventory in thinking, not in instructions.** A sidebar snapshot is data. `session.instructions.append` is for behavior and, on current phone-agent reports, it interrupts speech. `session.commentary.append` asks the model to talk. The matching public call is `session.thinking.append` with `delegation_id: null`, which is what the Share UI context section describes. This chooses the background-data channel, without promising silence.

**Send a summary, on change, in prose.** The 500-token cap rules out a full JSON dump of every server, bot, and session in one append on each tick. No builder thread in this pass argued for Markdown versus JSON versus YAML. The official example is short sentences (“The selected time is now 8 PM; the previous selection was 7 PM.”). A practical snapshot is a few lines: which session is in front, counts, names and statuses that changed, and anything the user might point at with “this one.” Skip the push when nothing changed. If several updates land in one second, send one summary of the latest state, not a stream of deltas. Say the correction in the text (“bot api-1 was running; it is now stopped”) because appends cannot edit the previous one.

**Seed the session with policy, not with the live inventory.** Startup `instructions` should be the voice role and the delegation policy (when to hand off: start, stop, open, inspect; when not to: greetings and questions already answered). Startup `session.input` is for resuming a conversation, up to 128 messages and 8,192 tokens. The first sidebar summary could be a thinking append as soon as `session.started` fires, or a developer message in `input` if the model must know it before the first word. Instructions persist; the thinking append can be summarized away later, so the app could push the summary again after a long quiet period or after a reconnect. This is a design option, not a restriction against supplying factual startup context.

**Keep the structured snapshot for the text model.** Client delegation lets the app choose exactly which history and which sidebar state each request gets. On `session.delegation.created` (`target: "client"`), save the id. The public event will not say what to do. Build the text-model prompt from recent transcript deltas (they are fragments, they can overlap, and they can be wrong) plus the latest structured snapshot. Do not pass the voice model’s tool trace; in this design the voice model has no tools. Do not pass the entire session history if a short tail plus the snapshot answers the request. The Decisions guide uses `gpt-6-luna` for the fast choice and a separate reasoning call only when the choice is “this needs more than a lookup.”

**Return on the same delegation id, and do not make the voice model infer success.** Spoken outcome: `session.commentary.append` with that id (“api-1 is stopped”). Progress the user need not hear yet: `session.thinking.append` with the same id (“stop requested, not confirmed”). If the sidebar changed while the tool ran, revalidate the action against current state instead of applying it to a stale row. A finished tool is not proof the user heard it.

**Do not open a second model call just to paraphrase.** If the tool result is already one sentence, commentary can carry that sentence. call4me’s reported rule is stronger: the back office writes almost nothing, because whatever it writes can be spoken. Priority tier (`service_tier: "priority"` on Responses delegation, or the equivalent on a direct fast-model call) is the documented latency knob. Prewarming was not described by any builder found here.

**Bound the long call in the app.** The platform manages compaction independently. Thinking appends may be gone or summarized later, including when LiveKit opens a new connection and resends history. Re-pushing a current sidebar summary is one possible recovery policy; this research does not establish an exposed compaction notification on which to trigger it. Do not rely on a user anecdote of “about two hours.” If the product must reset, the LiveKit pattern is a new session prefilled with a short transcript tail plus the current summary, under the 8,192-token startup cap.

**Watch the reported failure modes.** Instructions appended mid-utterance cut the caller off (Guillem). Commentary after tools can vanish with `context_injection_incomplete` (Prince). The model can promise an action and never delegate; call4me checks the transcript instead of trusting the handoff (and livetab\_ says to remeasure that rate on every model snapshot). A long stretch with no new push leaves the voice model answering from stale session context (Sosa). These reports motivate verification; they do not establish failure rates or authorize replaying uncertain actions.

## What this pass did not find

- Any tweet that uses `session.context.append`. That name does not match the published public API reviewed here.
- A builder thread that specifies Markdown, JSON, or YAML as the on-the-wire snapshot format. The docs say plain text, at most 500 tokens.
- A builder thread that publishes a throttle interval, a diff algorithm, or a token budget beyond the documented caps (16,384 instruction tokens, 8,192 startup history tokens, 500 tokens per append).
- Evidence that `session.thinking.append` is discussed by name on X. Builders talk about “short frames,” “append,” and “push,” and the only event name that showed up in the October steering thread was `session.instructions.append`, plus Prince’s `session.commentary.append` bug.
- A verified prewarming recipe.

Primary-source-verified in the fetched portions: the three append channels, the startup caps,
automatic compaction as described by Microsoft, client versus Responses delegation, the Decisions
prompt shape, LiveKit’s append-only and reconnect behavior, and call4me’s tool split and menu
recovery as far as the README goes. Desh Raj's essay is a fetched secondary-source summary.

Search-cited only: every tweet summary and date, the Share UI context section past the truncation
point, Uberti’s compaction wording, call4me’s “write almost nothing” line, and the two-hour window
anecdote. These remain unverified against full source text.

Hypothesis: the sidebar recipe in section 3.
