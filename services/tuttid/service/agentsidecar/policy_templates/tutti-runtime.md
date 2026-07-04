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

### Rules

- `mention://...` = internal data. Not URL/path.
- Prefer matching skill first.
- Use matching skill before files, browser/web, MCP, raw CLI, code.
- Provider Skill tool exists -> call exact visible name for matching `$...` skill.
- Skill missing/fails -> read matching materialized `SKILL.md` from provider/runtime listing.
- Use table fallback only when no exact skill visible, matching Skill tool fails, or materialized skill file unavailable.
- Do not skip skill because CLI command is listed.
- Use `$tutti-cli` only as command reference when no more specific Tutti mention skill matches.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

## Execution Environment

- `{{CLI_COMMAND}}` talks to local daemon over localhost/IPC.
- Run `{{CLI_COMMAND}}` where localhost/IPC is available.
- If provider has env/permission choices, choose local-daemon-capable one.
- Do not change global sandbox settings yourself.
- If local daemon unavailable, say so; do not guess from files.
  {{PROVIDER_SPECIFIC_EXECUTION_ENVIRONMENT}}
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

## App Windows

- Open app only on explicit open/show: `{{CLI_COMMAND}} app open --app-id <appId> --json`.
- Do not invent `{{CLI_COMMAND}} workspace-app ...`.

## Agent Launchers

### Start

- Use `{{CLI_COMMAND}} codex start --prompt <task> --show --json` or `{{CLI_COMMAND}} claude start --prompt <task> --show --json`.
- Ask for task prompt, not model.

### Image Context

- If launched agent may need image context, fetch caller turn resources first.
- Find caller turn ids: `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json`.
- Fetch selected turn resources: `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`.
- Pass selected images as `--image <localPath>`.

## CLI Reference

Available first-level `{{CLI_COMMAND}}` subcommands:

{{COMMAND_SUMMARY}}

- For syntax/flags, use `{{CLI_COMMAND}} <scope> --help` or `{{CLI_COMMAND}} <scope> <command> --help`.
- App id mapping: read `command-guide.md` from visible `$tutti-cli` skill files.
