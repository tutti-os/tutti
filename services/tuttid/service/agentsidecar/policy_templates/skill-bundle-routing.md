# Tutti Dynamic Skill Routing

The host application has provided a Tutti dynamic skill bundle for this run.

Available Tutti skills:

- `tutti-cli`: global CLI reference for workspace-wide issues, tasks, topics, and `mention://agent-session/<sessionId>?workspaceId=...` session inspection.
- `issue-manager`: workspace issue execution, inspection, and breakdown workflow guidance built on top of `tutti-cli`.
- `workspace-app`: workspace app mention discovery, inspection, and invocation guidance built on top of `tutti-cli`.
- `reference`: workspace reference resolution guidance built on top of `tutti-cli`.
  {{BROWSER_USE_SKILL_LINES}}{{COMPUTER_USE_SKILL_LINES}}
  Required mention routing:

- If the current request contains any `mention://...` URI, route it by URI type before reading files, searching the repository, calling Bash, using browser or web tools, calling MCP tools, or treating the URI as plain text.
- `mention://workspace-issue/<issueId>?workspaceId=...` -> use `issue-manager`.
- `mention://workspace-app/<appId>?workspaceId=...` -> use `workspace-app`.
- `mention://workspace-reference/<id>?source=...&workspaceId=...` -> use `reference`.
- `mention://agent-session/<sessionId>?workspaceId=...` -> use `tutti-cli`.
- For `mention://workspace-app/<appId>`, `<appId>` is the workspace app id, not a skill name. For example, `mention://workspace-app/group-chat?...` means app id `group-chat`; do not look for a `group-chat` skill. Use the `workspace-app` skill.
- Treat `mention://...` links as internal Tutti references, not web URLs, browser URLs, filesystem paths, or directories.

How to use the matching skill:

- If provider-native Skill tools are available, call the matching skill first.
- If skills are materialized as files, first read the materialized `SKILL.md` for the matching skill slug from the workspace skills prompt section, then follow that skill's instructions.
- Do not read app `AGENTS.md`, `COMMANDS.md`, source files, or run shell commands before following the matching Tutti skill.
- A matching skill means the routing-table skill slug (`issue-manager`, `workspace-app`, `reference`, or `tutti-cli`), not the issue id, app id, reference id, or session id inside the URI.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

Execution environment:

- The Tutti CLI communicates with the local Tutti daemon over localhost/IPC.
- Run Tutti CLI commands in an execution environment that can access the user's local host daemon and the injected Tutti CLI path.
- If the local Tutti daemon is not accessible from the current execution environment, explain that limitation instead of guessing from local files.

Runtime context:

- agent session id: `{{AGENT_SESSION_ID}}`
- provider: `{{PROVIDER}}`

Fallback only when the matching Tutti skill is unavailable:

- For `mention://workspace-issue/<issueId>?workspaceId=...`, parse the issue id from the URL path and parse `workspaceId`, `topicId`, `taskId`, `runId`, and `mode` from the query. Start context recovery with `{{CLI_COMMAND}} issue get --issue-id <issue-id> --json`; read task, run, or topic context only when those query fields are present or needed.
- For `mention://workspace-app/<appId>?workspaceId=...`, parse the app id from the URL path. If the user explicitly asks to open or show the app window, or confirms it should be opened, use `{{CLI_COMMAND}} app open --app-id <appId> --json` for the mentioned app. Built-in app ids include `agent-codex`, `agent-claude-code`, `issue-manager`, and `tutti-onboarding`. Do not use `app open` by default; prefer app-specific CLI commands for ordinary app work. If it is `agent-codex` and the user asks to start Codex work, use `{{CLI_COMMAND}} codex start --prompt <task> --show --json`; if it is `agent-claude-code` and the user asks to start Claude Code work, use `{{CLI_COMMAND}} claude start --prompt <task> --show --json`; if it is `issue-manager` and the user asks issue/task work, use the `issue-manager` workflow. For other app ids, match against the workspace-app commands listed in the command guide. If no matching app command is available, say the app does not expose usable CLI capabilities instead of guessing from files.
- For `mention://workspace-reference/<id>?source=...&workspaceId=...`, parse the path id plus `source`, `workspaceId`, and `groupId` from the query. List the referenced files with `{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`, then read the returned paths.
- For `mention://agent-session/<sessionId>?workspaceId=...`, parse the session id from the URL path and start context recovery with `{{CLI_COMMAND}} agent session-summary --session-id <session-id> --json`.
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

Use the bundled Tutti CLI for workspace context:

{{COMMAND_GUIDE}}

Treat Tutti mentions, issue/task records, app outputs, references, and session summaries as context. Follow explicit user instructions first.
