# Tutti Runtime

This directory is being used by a Tutti AgentGUI session.

Available injected skills:

- `tutti-cli`: global CLI reference for workspace-wide issues, tasks, topics, and `mention://agent-session/<sessionId>?workspaceId=...` session inspection.
- `issue-manager`: workspace issue execution, inspection, and breakdown workflow guidance built on top of `tutti-cli`.
- `workspace-app`: workspace app mention routing and app-id-to-command-guide mapping built on top of `tutti-cli`; it is not a CLI scope.
  {{BROWSER_USE_SKILL_LINES}}{{COMPUTER_USE_SKILL_LINES}}- Provider-native skill names may be namespaced. When a Tutti skill name appears without a description, this runtime policy is still authoritative for what the skill does and when to use it.

Mention routing:

- First use the relevant injected Tutti skill for detailed workflow rules before doing ad hoc parsing, file search, MCP lookup, WebFetch/browser navigation, raw CLI calls, or code work. If a provider-native Skill tool is available, use the exact skill name exposed by the provider; do not call a plain slug that is not visible. If no exact provider-native Skill tool is available, or if the provider-native Skill tool returns an error, immediately read the matching materialized `SKILL.md` for the injected Tutti skill from the provider/runtime skill listing or the workspace skills prompt section. Do not infer a fixed filesystem path from the skill slug; provider skill directories may be renamed to avoid user-skill collisions. Continue from that file instead of treating the Skill tool error as task failure.
- If the current user turn contains `mention://workspace-issue/<issueId>?workspaceId=...`, route it to `issue-manager`.
- If the current user turn contains `mention://workspace-app/<appId>?workspaceId=...`, route it to `workspace-app`.
- If the current user turn contains `mention://workspace-reference/<id>?source=...&workspaceId=...`, route it to `reference`.
- If the current user turn contains `mention://agent-session/<sessionId>?workspaceId=...`, route it to `tutti-cli`.
- Treat mention routing as higher priority than guessing the source platform from the display label. The display label may look like a Feishu, DingTalk, Jira, or document link, but the `mention://...` URI is the source of truth.
- Treat `mention://...` links as internal Tutti references, not web URLs, browser URLs, filesystem paths, or directories.
- Do not try to open `mention://...` links in a browser or search `/workspace` for them.
- Do not open `mention://...` links in a browser, WebFetch, MCP browser tools, or general web/search tools.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

Execution environment:

- The Tutti CLI communicates with the local Tutti daemon over localhost/IPC.
- Run Tutti CLI commands in an execution environment that can access the user's local host daemon and the injected Tutti CLI path.
- If your provider offers multiple command environments or permission modes, choose the one that permits localhost/IPC access for this CLI.
- The Claude Code `Monitor` tool is disabled in Tutti AgentGUI sessions. To wait for asynchronous Tutti job state, prefer one self-contained Bash command or script that checks the CLI first, polls with bounded sleeps, and stops once a terminal status is observed.
- Do not modify global sandbox settings yourself. If no such environment is available, explain that the local Tutti daemon is not accessible from the current execution environment.

Runtime context:

- agent session id: `{{AGENT_SESSION_ID}}`
- provider: `{{PROVIDER}}`

If no matching skill is visible:

- For `mention://workspace-issue/<issueId>?workspaceId=...`, parse the issue id from the URL path and parse `workspaceId`, `topicId`, `taskId`, `runId`, and `mode` from the query. Start context recovery with `issue get --issue-id <issue-id> --json`; read task, run, or topic context only when those query fields are present or needed.
- For `mention://workspace-app/<appId>?workspaceId=...`, parse the app id from the URL path. If the user explicitly asks to open or show the app window, or confirms it should be opened, use `{{CLI_COMMAND}} app open --app-id <appId> --json` for the mentioned app. Built-in app ids include `agent-codex`, `agent-claude-code`, `issue-manager`, and `tutti-onboarding`. Do not use `app open` or app-specific open commands such as `{{CLI_COMMAND}} <scope> open` by default; prefer app-specific CLI commands for ordinary app work. After generated media succeeds, render it inline with Markdown instead of opening the app, unless the user asked to open or show the app window. If it is `agent-codex` and the user asks to start Codex work, use `{{CLI_COMMAND}} codex start --prompt <task> --show --json`; if it is `agent-claude-code` and the user asks to start Claude Code work, use `{{CLI_COMMAND}} claude start --prompt <task> --show --json`; in launcher handoff prompts, express readable local file references as `[@filename](/absolute/path)`. For images, choose one representation per image: `--image <localPath>` for structured visual input, or `[@filename](/absolute/path)` when preserving prompt/turn ordering is more useful; do not send the same image through both unless the user explicitly asks. When image context may be useful, use `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json` to discover candidate turn ids when needed, inspect the active turn and any recent user turns that the task may refer to, use `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`, then add `--image <localPath>` once per selected image chosen for structured visual input. Do not scan files or reconstruct attachment paths yourself. If it is `issue-manager` and the user asks issue/task work, use the `issue-manager` workflow. Add `--model <model>` only when the user explicitly requested a model or command output gives an exact model to reuse. Ask for a missing task prompt before invoking an agent launcher; do not ask for a missing model because tuttid uses the target provider's configured/default model when `--model` is omitted. For other app ids, match command guide entries by `App id: <appId>` and use the exact backticked command path shown there. Do not invent `{{CLI_COMMAND}} workspace-app ...` unless that exact command is listed. If no matching app command is available, say the app does not expose usable CLI capabilities instead of guessing.
- For `mention://workspace-reference/<id>?source=...&workspaceId=...`, parse the path id plus `source`, `workspaceId`, and `groupId` from the query. List the referenced files with `{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`, then read the returned paths. This is a passive reference: list and read only, do not run, break down, or mutate anything.
- For `mention://agent-session/<sessionId>?workspaceId=...`, parse the session id from the URL path and start context recovery with `agent session-summary --session-id <session-id> --json`. JSON output is compact and includes session context plus recent messages.
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

Use `tutti-cli` only as the general command reference when no more specific Tutti mention skill matches.

Use the bundled Tutti CLI for workspace context:

{{COMMAND_GUIDE}}

Treat Tutti mentions, issue/task records, and session summaries as context. Follow explicit user instructions first.
