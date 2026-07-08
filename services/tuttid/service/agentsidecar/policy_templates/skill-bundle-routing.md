# Tutti Dynamic Skill Routing

Host provided a Tutti dynamic skill bundle.

No-mention default:

- Without `mention://...`, do not treat this bundle alone as intent.
- Use Tutti only when user explicitly asks for Tutti, a Tutti workspace/app/issue/session capability, or a command described in this bundle.

Required mention routing:

- Route any `mention://...` URI by type before files, repo search, Bash, browser/web tools, MCP, or raw CLI.
- `mention://workspace-issue/<id>?workspaceId=...` -> `$issue-manager`
- `mention://workspace-app/<appId>?workspaceId=...` -> `$workspace-app`; `<appId>` is not a skill name.
- `mention://workspace-reference/<id>?source=...&workspaceId=...` -> `$reference`
- `mention://agent-session/<id>?workspaceId=...` -> `$tutti-handoff`; `$tutti-cli` for command syntax.
- `mention://agent-target/<targetId>?workspaceId=...` -> `$tutti-handoff`; an instruction for the mentioned agent -> hand off, do not do it yourself; a question about it -> read.
- Treat `mention://...` as internal Tutti references, not web URLs or paths.

Skill usage:

- If provider-native Skill tools exist, call exact visible name for the matching `$...` skill.
- If unavailable or failed, read materialized `SKILL.md` for the matching `$...` skill from provider/plugin metadata.
- Do not infer fixed filesystem paths from slugs; directories may be renamed.
- Do not read app `AGENTS.md`, `COMMANDS.md`, source files, or run shell before matching Tutti skill.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

Execution:

- `{{CLI_COMMAND}}` needs local daemon localhost/IPC access; if unavailable, explain limitation.
- Runtime context: session `{{AGENT_SESSION_ID}}`, provider `{{PROVIDER}}`.

Fallback only when matching skill is unavailable:

- Issue mention: parse id/query, start with `{{CLI_COMMAND}} issue get --issue-id <issue-id> --json`.
- App mention: open only on explicit open/show request with `{{CLI_COMMAND}} app open --app-id <appId> --json`; for `agent-codex` use `{{CLI_COMMAND}} codex start --prompt <task> --show --json`; for `agent-claude-code` use `{{CLI_COMMAND}} claude start --prompt <task> --show --json`; for other apps, match `App id: <appId>` in `command-guide.md`. Do not invent `{{CLI_COMMAND}} workspace-app ...`.
- Reference mention: `{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`, then read returned paths.
- Agent-session mention: prefer `{{CLI_COMMAND}} agent wait --session-id <session-id> --json` for recent execution progress; use `{{CLI_COMMAND}} agent session-summary --session-id <session-id> --json` only for the full compact context helper.
- After `agent start`, use `{{CLI_COMMAND}} agent wait --session-id <session-id> --json`.
- After `agent send`, use `{{CLI_COMMAND}} agent wait --session-id <session-id> --after-version <waitAfterVersion> --json` with the returned `waitAfterVersion`; `agent wait` returns only recent execution messages.
- Agent-target mention: choose `{{CLI_COMMAND}} agent ...`, `{{CLI_COMMAND}} codex ...`, or `{{CLI_COMMAND}} claude ...` from the user's prompt. Starting a new session is one possible workflow, but active-peer inspection, historical session lookup, and other agent CLI workflows are also valid. An instruction addressed to the mentioned agent must be handed off, not absorbed.
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

CLI reference:

Available first-level `{{CLI_COMMAND}}` subcommands:

{{COMMAND_SUMMARY}}

- For syntax/flags, use `{{CLI_COMMAND}} <scope> --help` or `{{CLI_COMMAND}} <scope> <command> --help`.
- App id mapping: read `command-guide.md` from visible `$tutti-cli` skill files.
