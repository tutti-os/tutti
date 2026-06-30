# Tutti Dynamic Skill Routing

The host application has provided a Tutti dynamic skill bundle for this run.

No-mention default:

- When the current user turn has no `mention://...` URI, do not treat this dynamic skill bundle by itself as routing intent. Continue with the host application's native tools, MCP servers, and system prompt unless the user explicitly asks for Tutti, a Tutti workspace/app/issue/session capability, or a command described in this bundle.
- Do not choose Tutti routing, Tutti skills, or a shell-mediated Tutti CLI call merely because this bundle or command guide is present. This guidance does not restrict host-application tools that are needed for the user's non-Tutti task.

Available Tutti skills:

- `tutti-cli`: global CLI reference for workspace-wide issues, tasks, topics, and `mention://agent-session/<sessionId>?workspaceId=...` session inspection.
- `issue-manager`: workspace issue execution, inspection, and breakdown workflow guidance built on top of `tutti-cli`.
- `workspace-app`: workspace app mention routing and app-id-to-command-guide mapping built on top of `tutti-cli`; it is not a CLI scope.
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

- If provider-native Skill tools are available, call the matching skill first using the exact skill name exposed by the provider. Do not guess a provider-native tool name from the routing slug.
- If no exact provider-native Skill tool is available, or if the provider-native Skill tool returns an error, read the materialized `SKILL.md` for the matching skill slug from the workspace skills prompt section, then follow that skill's instructions instead of treating the Skill tool error as task failure.
- If skills are materialized as files and no provider-native Skill tool is available, first read the materialized `SKILL.md` for the matching skill slug from the workspace skills prompt section, then follow that skill's instructions.
- Do not infer a fixed filesystem path from the skill slug; materialized skill directories may be renamed to avoid user-skill collisions.
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
- For `mention://workspace-app/<appId>?workspaceId=...`, parse the app id from the URL path. If the user explicitly asks to open or show the app window, or confirms it should be opened, use `{{CLI_COMMAND}} app open --app-id <appId> --json` for the mentioned app. Built-in app ids include `agent-codex`, `agent-claude-code`, `issue-manager`, and `tutti-onboarding`. Do not use `app open` or app-specific open commands such as `{{CLI_COMMAND}} <scope> open` by default; prefer app-specific CLI commands for ordinary app work. After generated media succeeds, render it inline with Markdown instead of opening the app, unless the user asked to open or show the app window. If it is `agent-codex` and the user asks to start Codex work, use `{{CLI_COMMAND}} codex start --prompt <task> --show --json`; if it is `agent-claude-code` and the user asks to start Claude Code work, use `{{CLI_COMMAND}} claude start --prompt <task> --show --json`; in launcher handoff prompts, express readable local file references as `[@filename](/absolute/path)`. For images, choose one representation per image: `--image <localPath>` for structured visual input, or `[@filename](/absolute/path)` when preserving prompt/turn ordering is more useful; do not send the same image through both unless the user explicitly asks. When image context may be useful, use `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json` to discover candidate turn ids when needed, inspect the active turn and any recent user turns that the task may refer to, use `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`, then add `--image <localPath>` once per selected image chosen for structured visual input. Do not scan files or reconstruct attachment paths yourself. If it is `issue-manager` and the user asks issue/task work, use the `issue-manager` workflow. For other app ids, match command guide entries by `App id: <appId>` and use the exact backticked command path shown there. Do not invent `{{CLI_COMMAND}} workspace-app ...` unless that exact command is listed. If no matching app command is available, say the app does not expose usable CLI capabilities instead of guessing from files.
- For `mention://workspace-reference/<id>?source=...&workspaceId=...`, parse the path id plus `source`, `workspaceId`, and `groupId` from the query. List the referenced files with `{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`, then read the returned paths.
- For `mention://agent-session/<sessionId>?workspaceId=...`, parse the session id from the URL path and start context recovery with `{{CLI_COMMAND}} agent session-summary --session-id <session-id> --json`.
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

Use the bundled Tutti CLI for routed Tutti context:

{{COMMAND_GUIDE}}

Treat Tutti mentions, issue/task records, app outputs, references, and session summaries as context. Follow explicit user instructions first.
