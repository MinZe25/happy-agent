# Bot settings

The owner's restrictions on each bot, and which bot governs any given agent. A bot's settings
apply to the bot's own agent and to every agent working under it: its subtasks, their
collaborators, workflow agents, its exported-bot conversations, and tasks it opens.

## Settings

| Setting            | Default           | Meaning                                                                                                 |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `allowedSecretIds` | `null`            | `null` restricts nothing. An array is the complete set of usable secret IDs; `[]` allows none.          |
| `crossWorkspace`   | `true`            | `false` keeps governed agents to the bot's own tree. `true` leaves reach to `features.cross_workspace`. |
| `compute`          | `{"type":"host"}` | `{"type":"docker","image":"…"}` builds each governed agent's machine in a container of that image.      |

A bot without a stored row runs with the defaults, which are exactly the behavior before bot
settings existed. Reach only ever narrows: no bot setting gives an agent more than the
installation's `features.cross_workspace` allows.

## Governance

Settings are keyed by the bot's own agent ID, and an agent is governed by the agent at the root of
its tree. Every descendant is therefore covered by ancestry alone, from the moment it exists, with
nothing copied to it. A root created from inside a tree — a task a bot opened — is linked to that
tree's root when it is created, in the same transaction, and stays governed by it for life. The
walk is bounded; a cycle or an overlong chain is corrupt ancestry and fails closed, as does a
stored row this module cannot read.

`root(ctx, agentId)` answers which agent's tree governs an agent. `RunnersModule` uses it to run
every agent under a bot as the Linux user `[execution.bots]` gives that bot.

## Who enforces what

This module only stores settings and answers questions about them. The module that owns each
capability enforces its part, so no restriction is prompt text:

- **Secrets** bounds `list_secrets`, `reference_secret`, `attach_secret`, `detach_secret`, and
  `update_secret` by the allowlist, refuses `create_secret` under any allowlist, and filters every
  command's resolution, so inherited project and workspace attachments cannot get around it.
- **Collaboration**, **scheduling**, and **history** refuse messages, scheduled messages (when
  scheduled and again when due), and history reads aimed outside the bot's tree when reach is off.
- **Projects**, **workspaces**, **tasks**, and the **bots** roster withhold their tools when reach is
  off; `send_bot_message` is refused as well.
- **Subtasks** refuses a workspace-bound subtask when reach is off. Subtasks that share the bot's
  folder, and exported-bot conversations, are unaffected.
- **Compute** reads the compute setting only while it builds an agent's machine. A workspace that
  already runs in Docker keeps its own image.

A secrets or reach change applies on each agent's next model request, because tools and
instructions are resolved per request. A compute change applies the next time each machine is
built: new agents at once, running agents after Happy Agent restarts.

## Changing settings

The bots catalog decides who may change them: active admin bots through `get_bot_settings` and
`update_bot_settings`, and the owner's direct `BotsModule.updateSettings`. `write` refuses any agent
that is not a root, normalizes the allowlist as a sorted set, ignores a write of what is already
stored, and publishes `bot_settings_updated` inside the transaction and again after it commits.
`widenings` names, in reviewer-facing words, every way a change gives governed agents more.

## Storage

Migration `001-bot-settings` creates `happy_agent_module_bot_settings` (one row per configured
bot agent, with a version) and `happy_agent_module_bot_settings_roots` (adopted roots and the tree
root that governs each).
