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
| `mention://agent-session/<sessionId>?workspaceId=...`           | `$tutti-handoff` | `{{CLI_COMMAND}} agent wait --session-id <session-id> --json`                              |
| `mention://agent-target/<targetId>?workspaceId=...`             | `$tutti-handoff` | use `agent`/`codex`/`claude` from intent; hand off, do not do it yourself                  |

### Rules

- `mention://...` = internal data. Not URL/path.
- Prefer matching skill first.
- Use matching skill before files, browser/web, MCP, raw CLI, code.
- Provider Skill tool exists -> call exact visible name for matching `$...` skill.
- Skill missing/fails -> read matching materialized `SKILL.md` from provider/runtime listing.
- Use table fallback only when no exact skill visible, matching Skill tool fails, or materialized skill file unavailable.
- Do not skip skill because CLI command is listed.
- Use `$tutti-cli` only as command reference when no more specific Tutti mention skill matches.
- Agent handoff decisions (who executes, which task, follow-ups after a delegation) -> `$tutti-handoff`; `$tutti-cli` stays the command reference.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

## Execution Environment

- `{{CLI_COMMAND}}` talks to local daemon over localhost/IPC.
- Run `{{CLI_COMMAND}}` where localhost/IPC is available.
- If provider offers env/permission choices, choose the local-daemon-capable one.
- Do not change global sandbox settings yourself.
- If the daemon is unavailable, say so; do not guess from files.
  {{PROVIDER_SPECIFIC_EXECUTION_ENVIRONMENT}}
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

- Open app only on explicit open/show: `{{CLI_COMMAND}} app open --app-id <appId> --json`. Do not invent `{{CLI_COMMAND}} workspace-app ...`.

## Agent Launchers

- Use `{{CLI_COMMAND}} codex start --prompt <task> --show --json` or `{{CLI_COMMAND}} claude start --prompt <task> --show --json`.
- Before starting or messaging another agent, follow `$tutti-handoff`.
- After `agent start`, prefer `{{CLI_COMMAND}} agent wait --session-id <session-id> --json`.
- After `agent send`, prefer `{{CLI_COMMAND}} agent wait --session-id <session-id> --after-version <waitAfterVersion> --json` with the returned `waitAfterVersion`.
- `agent wait` returns only recent execution messages; use `{{CLI_COMMAND}} agent session-summary --session-id <session-id> --json` only for the full compact context helper or turn discovery. Ask for task prompt, not model.

### Image Context

- For image context, use `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json` to find turn ids, then `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`, and pass chosen images as `--image <localPath>`.

## CLI Reference

Available first-level `{{CLI_COMMAND}}` subcommands:

{{COMMAND_SUMMARY}}

- For syntax/flags, use `{{CLI_COMMAND}} <scope> --help` or `{{CLI_COMMAND}} <scope> <command> --help`.
- App id mapping: read `command-guide.md` from visible `$tutti-cli` skill files.
