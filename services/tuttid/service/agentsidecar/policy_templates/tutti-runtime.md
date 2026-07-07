# Tutti Runtime

This directory is being used by a Tutti AgentGUI session.

## Session

- session: `{{AGENT_SESSION_ID}}`
- provider: `{{PROVIDER}}`

## Mention Routing

### Routes

| URI                                                             | Skill            | Fallback CLI Command                                                                       |
| --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `mention://workspace-issue/<issueId>?workspaceId=...`           | `$issue-manager` | `{{CLI_COMMAND}} issue get --issue-id <issue-id> --json`                                   |
| `mention://workspace-app/<appId>?workspaceId=...`               | `$workspace-app` | match `App id: <appId>` in command guide                                                   |
| `mention://workspace-reference/<id>?source=...&workspaceId=...` | `$reference`     | `{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json` |
| `mention://agent-session/<sessionId>?workspaceId=...`           | `$tutti-cli`     | `{{CLI_COMMAND}} agent session-summary --session-id <session-id> --json`                   |
| `mention://agent-target/<targetId>?workspaceId=...`             | `$tutti-cli`     | use `agent`/`codex`/`claude` from intent; not launch-only                                  |

- `mention://...` = internal data, not URL/path.
- Prefer the matching skill before other tools. If it is missing or fails, read the materialized `SKILL.md`; use the table fallback only after that.
- Use `$tutti-cli` only as command reference when no more specific Tutti mention skill matches.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

## Execution Environment

- `{{CLI_COMMAND}}` talks to the local daemon over localhost/IPC; run it where localhost/IPC is available.
- If provider offers env/permission choices, choose the local-daemon-capable one.
- If the daemon is unavailable, say so; do not guess from files.
  {{PROVIDER_SPECIFIC_EXECUTION_ENVIRONMENT}}
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

- Open app only on explicit open/show: `{{CLI_COMMAND}} app open --app-id <appId> --json`. Do not invent `{{CLI_COMMAND}} workspace-app ...`.

## Agent Launchers

- Use `{{CLI_COMMAND}} codex start --prompt <task> --show --json` or `{{CLI_COMMAND}} claude start --prompt <task> --show --json`.
- After `agent start`, prefer `{{CLI_COMMAND}} agent wait --session-id <session-id> --json`.
- After `agent send`, prefer `{{CLI_COMMAND}} agent wait --session-id <session-id> --after-version <waitAfterVersion> --json` with the returned `waitAfterVersion`.
- `agent wait` returns only recent execution messages; use `agent session-summary` for full context. Ask for task prompt, not model.

### Image Context

- For image context, use `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json` to find turn ids, then `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`, and pass chosen images as `--image <localPath>`.

## CLI Reference

Available first-level `{{CLI_COMMAND}}` subcommands:

{{COMMAND_SUMMARY}}

- For syntax/flags, use `{{CLI_COMMAND}} <scope> --help` or `{{CLI_COMMAND}} <scope> <command> --help`.
- App id mapping: read `command-guide.md` from visible `$tutti-cli` skill files.
