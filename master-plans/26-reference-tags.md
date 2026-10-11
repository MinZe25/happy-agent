# Master plan 26: reference tags

## Big picture

Agents mention Happy entities in their replies, and a person should be able to click straight
through to them. We take one idea from ChatGPT's Intelligent UI: the model writes a small tag that
carries only an ID, and the system fills in the live data. We leave out its generative-UI runtime.

An agent writes `<happy-KIND id="…"/>` inline in its Markdown reply. The tag carries only the ID.
The model never writes a title. Clients look up the live title and state themselves. The kinds are
`artifact` (with an optional `version="N"`), `agent` (tasks, subtasks, and bots' agents),
`workspace`, `project`, and `service`. Files get no tag; they stay `path:line` auto-links.

## Rendering

Every reference renders as a plain clickable underlined link. Its text is the live title. A tag
alone on its line renders the same as one inside a sentence. There is no chip or card. When the
entity is busy, the client shows its usual progress treatment on the link text: an agent working,
a service running, or anything still being set up. On desktop that is the shimmer. A reference
with an unknown, deleted, or not-visible ID renders as inert text, and so does one of an unknown
kind.

While a reply streams, a partial trailing tag such as `<happy-arti` is never shown as raw text.
A surface that cannot render tags gets readable plain Markdown, such as the artifact's title, never
a raw tag. That covers Telegram, the Happy mobile app, and other integrations.

## One implementation

The grammar, the parser, the partial-tag rule, and the Markdown fallback live in one place,
`@slopus/happy-agent-client`. Desktop, every other client, and the daemon use that code
unchanged. The daemon validates and resolves where it already owns the catalog and permissions,
and it uses the fallback renderer for outbound integrations. `API.md` specifies the syntax.

## Where we are

`API.md` specifies the tag family, and the shared parser has shipped in the client. On desktop,
artifact, agent, workspace, and project references are clickable links. Service references stay
inert for now.

## Order and criteria

1. Artifacts. The artifact tools return the exact tag to paste. The agent instructions tell agents
   to use the tag when they mention an artifact. Desktop renders artifact references as live
   links. Done when an agent that publishes an artifact mentions it by tag and a person clicks
   through from chat.
2. Agents, workspaces, and projects. Their owning modules' tools return the exact tag, and their
   instructions tell agents to mention them by tag. Done when each kind opens from chat with its
   busy state showing.
3. Services. They are specified and parsed but render inert until a client renders them. Their
   module starts emitting tags at that point.
4. Fallback everywhere. Every outbound integration, starting with the Happy mobile app, relays the
   fallback, never a raw tag. Done when no integration shows a raw tag.

## Future direction: choices

A later tier adds `<happy-choice>` follow-up buttons that send a new turn when pressed. This is a
direction only. Do not build it until it is planned.
