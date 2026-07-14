# Tutti Dynamic Skill Routing

Host provided a Tutti dynamic skill bundle.

{{ENVIRONMENT_POLICY_SECTIONS}}

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
- App mention: open only on explicit open/show request with `{{CLI_COMMAND}} app open --app-id <appId> --json`; otherwise match `App id: <appId>` in `command-guide.md`. Agent launches use `agent-target` mentions and the generic agent workflow, not provider-specific workspace-app commands. Do not invent `{{CLI_COMMAND}} workspace-app ...`.
- Reference mention: `{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`, then read returned paths.
- Agent-session mention: prefer `{{CLI_COMMAND}} agent wait --session-id <session-id> --json` for blocking progress checks without fetching execution messages; use `{{CLI_COMMAND}} agent session-summary --session-id <session-id> --json` only for the full compact context helper.
- After `agent start`, use `{{CLI_COMMAND}} agent wait --session-id <session-id> --json`.
- After `agent send`, use `{{CLI_COMMAND}} agent wait --session-id <session-id> --json`; `agent wait` does not fetch execution messages.
- Agent-target mention: run `{{CLI_COMMAND}} agent list --agent-id <targetId> --json` to verify the current agent, then use `{{CLI_COMMAND}} agent start --agent-id <targetId> --prompt <task> --show --json` when a new session is required. Do not infer provider-specific commands or assume a fixed agent catalog. Active-peer inspection, historical session lookup, and other generic agent workflows are also valid. An instruction addressed to the mentioned agent must be handed off, not absorbed.
  {{TOOLS_POLICY_SECTIONS}}

{{SKILL_STRATEGY_POLICY_SECTIONS}}

CLI reference:

Available first-level `{{CLI_COMMAND}}` subcommands:

{{COMMAND_SUMMARY}}

- For syntax/flags, use `{{CLI_COMMAND}} <scope> --help` or `{{CLI_COMMAND}} <scope> <command> --help`.
- App id mapping: read `command-guide.md` from visible `$tutti-cli` skill files.

{{SPECIALIZED_POLICY_SECTIONS}}
