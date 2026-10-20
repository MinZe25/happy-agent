# Harnesses: Claude Code, Codex CLI, Antigravity, OpenCode, and ACP agents

Use this recipe when the user wants a Happy agent to run on another vendor's whole agent rather
than on Happy's own loop: Claude Code itself, Codex CLI itself, Google Antigravity, OpenCode, or
any agent with an [Agent Client Protocol](https://agentclientprotocol.com) server. Accounts and
their credentials stay in [Accounts and models](accounts-and-models.md); a harness only says who
runs the agent loop on them.

## What changes for the user

Happy's own harness runs the loop with Happy's prompt, tools, and compaction. The `claude_code`
harness runs Claude Code itself on a `claude` account: its own prompt, tools, settings, skills,
sub-agents, and compaction. `codex_cli` does the same for Codex on a `codex` account.
Antigravity, OpenCode, and other ACP agents sign in themselves, so each is offered as an account
of its own, named after its harness.

Either way the conversation stays a Happy conversation. Happy's history is the record, and the
agent's own session is kept in step with it. Happy's tools (projects, sub-agents, artifacts,
messaging, and the rest) reach the agent over MCP, and Happy's permission mode is mapped onto the
agent's own. Sending a message while the agent works steers it: Claude Code and Codex CLI take it
mid-turn; Antigravity, OpenCode, and other ACP agents are interrupted and continue from the new
message. Stop ends the agent's turn and the commands it was running.

| Harness       | Runs                                   | On                               | Needs on the machine                  |
| ------------- | -------------------------------------- | -------------------------------- | ------------------------------------- |
| `happy`       | Happy's own loop                       | every provider (default)         | nothing                               |
| `claude_code` | Claude Code, through the Agent SDK     | `claude` providers (default all) | nothing; Happy ships Claude Code      |
| `codex_cli`   | Codex, through `codex app-server`      | `codex` providers (default all)  | the pinned Codex, a `codex`, or `npx` |
| `antigravity` | Antigravity, through `antigravity-acp` | its own login                    | `agy` signed in, Bun, and `npx`       |
| `opencode`    | OpenCode, through `opencode acp`       | its own login                    | `opencode` signed in                  |
| any, `acp`    | any ACP agent, from its `command`      | its own login                    | that agent, installed and signed in   |

## Before editing

Follow [Accounts and models](accounts-and-models.md#before-editing): the file is the user
`happy.toml`, read it with credentials redacted, back it up, and never print or copy credentials.

## Add harnesses

Accounts stay as they are. Add a `[harnesses.<id>]` table per harness; writing the table turns
it on, and `enabled = false` turns it off again. Built-in IDs need no `type`.

```toml
[providers.claude]                       # built-in; shows as "Current CLI"
enabled = true

[providers.claude_alex_acme]
type = "claude"
name = "alex acme"
oauth_token = "<from claude setup-token>"

[providers.codex]                        # built-in; shows as "Current CLI"
enabled = true

[harnesses.claude_code]                  # Claude Code on these accounts
providers = ["claude", "claude_alex_acme"]   # default: every type = "claude" provider

[harnesses.codex_cli]                    # Codex CLI on every codex account
# command = "codex"                      # optional: a codex of your choice
# args = ["app-server"]

[harnesses.antigravity]                  # shows as "Antigravity"

[harnesses.opencode]                     # shows as "OpenCode"

[harnesses.goose]                        # any ACP agent
type = "acp"
name = "Goose"
command = "goose"
args = ["acp"]
env = { GOOSE_PROVIDER = "openai" }
```

`[harnesses.happy]` exists by default. Give it `providers = [...]` to keep Happy's own loop to
those accounts, or `enabled = false` to leave only foreign agents.

Claude Code uses the account's `oauth_token`, `api_key`, `auth_token`, or `config_dir`, or the
machine's Claude Code login for the built-in `claude`. Codex CLI uses the account's `api_key`, or
the folder holding its `auth_file` (which must be named `auth.json`) as `CODEX_HOME`, or
`~/.codex` for the built-in `codex`. Antigravity and OpenCode use their own logins; set `api_key`
on their harness to use a key instead. A generic `acp` agent gets credentials only through `env`
or its own login.

Then [reload the daemon](../configuration.md#applying-configuration-changes).

## Models

Each agent decides which models exist. Each time the daemon starts, it starts every enabled
harness once per account in the background, opens an empty session without prompting it, reads
the models and efforts the agent offers, and keeps the answer. Model IDs are
`<harness type>/<the agent's own model value>`, such as `claude-code/opus`,
`codex-cli/gpt-6.1-sol`, `opencode/openai/gpt-5.5`, or `acp/goose/<model>` for a generic agent.

The picker lists each account's models from every harness on it: Happy's models and, beside them,
`Claude Code · Opus` and the rest. Until an agent has answered once, Claude Code, Codex CLI, and
Antigravity offer a short built-in list; OpenCode and generic ACP agents offer nothing. If an
agent never answers, the daemon log says why, usually a missing login or command.

The harness picks, hides, and orders from what its agent offers:

```toml
[harnesses.claude_code]
include_models = ["claude-code/opus", "claude-code/sonnet"]   # only these, in this order
exclude_models = ["claude-code/haiku"]
```

IDs the agent does not offer are ignored, and `exclude_models` wins. An account's own
`include_models` and `exclude_models` still apply to every model on it, so list Claude Code models
there too when the account already filters. Smart pools never rotate foreign agents: a Claude Code
or Codex conversation stays on the account that started it. Switching a conversation between
Happy's loop and a foreign agent starts a fresh context with a handoff.

## Sub-agents

A Happy agent on any harness can create Happy sub-agents with Happy's `create_agent` tool, on any
available provider and model. A sub-agent created on a foreign harness is an ordinary Happy agent
with its own foreign session. The foreign agent's own sub-agents (Claude Code's Task tool, Codex's
agents) stay inside it; Happy shows each as one tool call.

## Generic ACP agents

A generic agent gets Happy's tools only if it accepts HTTP MCP servers over ACP. Its model
selector must be an ACP session config option of category `model`. Happy's permission mode
answers the agent's permission requests (Read only refuses them); everything the agent does
without asking follows its own settings, so set those to match what the user expects.

## Check

1. In a temporary project (see [Testing a deployed node](README.md#testing-a-deployed-node)),
   start a session on the new harness's model and confirm its models appear in the picker.
2. Ask it to create a file with its own tools and then call a Happy tool, such as listing
   projects. Confirm both happen.
3. Send a second message while it runs a long command and confirm it steers.
