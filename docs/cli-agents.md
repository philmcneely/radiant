# Claude Code and Codex inside Radiant

Radiant can use the coding agents already installed and signed in on this Mac,
with the person's own subscription (no API keys), in two ways:

1. **Import** a conversation either tool saved, and carry on with it in Radiant.
2. **Run** a new Radiant chat with one of them as the backend.

Code: `server/cli-agents.js` (readers, runner), `server/cli-agents-routes.js`
(HTTP). Tests: `scripts/test-cli-sessions.mjs`, `scripts/test-cli-run.mjs`.

## Settings

Both live in `settings.cliAgents`, saved with the normal `PUT /api/settings`.

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | Nothing below works until this is `true`. |
| `allowRemote` | `false` | Lets a phone or second Mac (anything that is not this Mac's own window) use the feature too. |

`cliAgents` is in `MACHINE_KEYS` (`server/config.js`): it describes **this Mac's**
history, so it is stored in `~/.radiant-machine.json` and never in the synced
config folder. Turning it on for one Mac must not turn it on for another Mac that
shares the folder and never agreed. `PUT /api/settings` ignores `cliAgents` from a
remote device: only the Mac itself can change it. Only a literal `true` counts.

## Privacy

- **Opt-in.** Off by default. Reading someone's whole conversation history with
  two other tools, including every file those tools opened, is not something
  Radiant does unasked. Every route answers `403` with a plain sentence until it
  is on.
- **This Mac only by default.** A request that did not come from the Mac itself
  (including anything through a proxy such as Tailscale Serve) is refused with
  `403 cli-agents-remote` unless `allowRemote` is on.
- **Only the two session folders are read:** `~/.claude/projects/*/<id>.jsonl`
  and `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`
  (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored). Ids are checked against
  the shape the tools write before they touch a path, files are found by
  walking real directory entries (a symlink is skipped, never followed), and
  every file's real path is checked to sit inside its root.
- **Never credentials.** Nothing opens `~/.claude/.credentials*`,
  `~/.codex/auth.json` or any token. The only other files read are the tool's
  `--version` / `--help` output, `~/.codex/config.toml` (the top-level `model`
  line only) and `~/.codex/models_cache.json` (model names and visibility only).
- **Nothing is copied anywhere.** Summaries are computed on request and cached in
  memory, keyed by path and modification time. Nothing is logged.
- **No API billing by accident.** The tool is started without
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `OPENAI_API_KEY`, `CODEX_API_KEY` and the `CLAUDE_CODE_*` variables of any
  session that launched Radiant, so it uses its own sign-in.

## What these chats are (and are not)

The tool is the agent. Its model, tools, skills and memory do the work. Radiant's
own tools, skills, memory, Jev, checkpoints, task board rules and approval
prompts do **not** apply; Radiant carries the message in, streams the reply into
the normal chat view, and keeps the transcript. Attachments are not sent (a
notice says so). Switching a chat from a normal model to Claude Code or Codex
starts a fresh conversation inside the tool: it does not see the earlier
Radiant messages.

## Permissions

The tools run headless, with nobody to answer "may I?". Radiant's approval
setting (`settings.approvalMode`) is translated into what can be decided up front:

| Radiant | Claude Code `--permission-mode` | Codex `sandbox_mode` |
| --- | --- | --- |
| Ask each (`ask`, default) | `plan` (read and research only) | `read-only` |
| Auto approve (`auto`) | `acceptEdits` | `workspace-write` |
| Allow all (`off`) | `bypassPermissions` | `danger-full-access` |

Claude Code also gets `--permission-prompts none` (when the installed version has
it), so anything the mode would still ask about is declined at once instead of
waiting forever; Codex runs with `approval_policy="never"`. Declined tools are
listed in a notice in the chat. The first reply of a chat, and any reply after
the setting changes, carries a one-line notice saying which of the three applies.
Codex gets the sandbox through `-c sandbox_mode=…` rather than `--sandbox`
because `codex exec resume` has no `--sandbox` flag but honors `-c`.

## API

All JSON. `403` bodies are `{ error, code }` with `code` `cli-agents-disabled`
or `cli-agents-remote`.

- `GET /api/cli-agents[?fresh=1]` — always answers (names and versions only).
  `{ enabled, allowRemote, usable, remote, agents: [{ id, label, bin, version,
  available, hint }], providers: [{ id, name, cli: true, models: [{ id, label }] }] }`.
  `usable` is what this request may do; `providers` is empty unless usable.
- `GET /api/cli-sessions?tool=&q=&limit=&since=` — `{ sessions: [{ tool, id, cwd,
  title, gitBranch, model, startedAt, updatedAt, messageCount, sizeBytes,
  imported, radiantId }] }`, newest first. `messageCount` is approximate and
  `null` for files over 16 MB. Sidechains, sub-agent threads and empty sessions
  are left out. `tool` is `claude-code` or `codex`.
- `POST /api/cli-sessions/import { tool, id }` — returns the Radiant session
  (same shape as `POST /api/sessions`) with `provider` = the tool,
  `model` = the tool's model or `null`, `cwd`, the converted `messages`,
  `cli: { tool, id, importedAt }` and `cliImport: { total, kept, truncated }`.
  The Radiant id is `cli-cc-<id>` / `cli-cx-<id>`, so importing twice returns the
  same chat. Only the last 400 messages are kept (`truncated: true` says so);
  a file over 48 MB is read from its end and `total` is `null`.
- `GET /api/models` also returns `{ id, label, provider: 'claude-code'|'codex',
  providerName: 'Claude Code (subscription)'|'Codex (subscription)', cli: true }`
  for each installed tool, only when `usable`. Claude Code offers `default`,
  `opus`, `sonnet`, `haiku` and any alias its own `--help` lists; Codex offers
  `default` and the models its catalog cache lists.
- `POST /api/chat` with a session whose `provider` is `claude-code` or `codex`
  streams the usual events (`text_delta`, `thinking_delta`, `tool_start`,
  `tool_result`, `usage`, `notice`, `stats`, `title`, `done`/`halt`+`error`,
  `closed`). The reply is saved with `via` and `model`; `session.cli = { tool,
  id }` is updated from what the tool reports, and the next message resumes it
  (`claude --resume <id>` / `codex exec resume <id>`). Resuming only works from
  the same folder for Claude Code, so a chat whose folder is gone says so.
  `session.effort` (`low` … `max`) is passed as the tool's effort.
- `GET /api/sessions` rows now carry `cli: { tool, id } | null`.

## Reading the tools' output

Claude Code: `claude -p --output-format stream-json --verbose
--include-partial-messages`, prompt on stdin. `stream_event` text/thinking deltas
are shown live; whole `assistant` messages become the saved parts; `tool_use` /
`tool_result` pairs become tool parts (`Bash`→`run_command`, `Read`→`read_file`,
`Write`→`write_file`, `Edit`→`edit_file`; others keep their names); sub-agent
traffic (`parent_tool_use_id`) is skipped; `result.usage` is the turn's total.
Codex: `codex exec --json`, prompt on stdin: `item.completed` messages, commands,
file changes and tool calls; `turn.completed.usage`; `turn.failed` is the error.

## Limits

- The tool is stopped (SIGTERM to its whole process group, SIGKILL after 3 s) when
  the turn is stopped or the connection drops, and after **10 minutes without any
  output** (`RADIANT_CLI_IDLE_MS`; `RADIANT_CLI_KILL_MS` sets the 3 s). A single
  silent command longer than that will be cut off.
- Codex does not stream partial text: each message appears when it is complete.
- Codex does not report which model answered unless one was chosen.
- A conversation open in a terminal at the same time as in Radiant is two writers
  to one file; the tools do not coordinate that.
- Codex's older archived rollouts (`archived_sessions/*.zst`) are not read.
- If a tool's login has expired the chat says to sign in again in Terminal
  (`claude`, `codex login`); Radiant never handles the sign-in itself.
- `CLAUDE_BIN` / `CODEX_BIN` point Radiant at a specific binary.
