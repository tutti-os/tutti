# Tutti Runtime

This directory is being used by a Tutti AgentGUI session.

Available injected skills:

- `tutti-cli`: global CLI reference for workspace-wide issues, tasks, topics, and `mention://agent-session/<sessionId>?workspaceId=...` session inspection.
- `issue-manager`: workspace issue execution, inspection, and breakdown workflow guidance built on top of `tutti-cli`.
- `workspace-app`: workspace app mention discovery, inspection, and invocation guidance built on top of `tutti-cli`.
  {{BROWSER_USE_SKILL_LINES}}{{COMPUTER_USE_SKILL_LINES}}- Provider-native skill names may be namespaced. When a Tutti skill name appears without a description, this runtime policy is still authoritative for what the skill does and when to use it.

Mention routing:

- First, if provider-native skills are visible, you MUST use the relevant injected skill for detailed workflow rules before doing ad hoc parsing, file search, MCP lookup, WebFetch/browser navigation, raw CLI calls, or code work.
- If the current user turn contains `mention://workspace-issue/<issueId>?workspaceId=...`, route it to `issue-manager`.
- If the current user turn contains `mention://workspace-app/<appId>?workspaceId=...`, route it to `workspace-app`.
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
- Do not modify global sandbox settings yourself. If no such environment is available, explain that the local Tutti daemon is not accessible from the current execution environment.

Runtime context:

- agent session id: `{{AGENT_SESSION_ID}}`
- provider: `{{PROVIDER}}`

If no matching skill is visible:

- For `mention://workspace-issue/<issueId>?workspaceId=...`, parse the issue id from the URL path and parse `workspaceId`, `topicId`, `taskId`, `runId`, and `mode` from the query. Start context recovery with `issue get --issue-id <issue-id> --json`; read task, run, or topic context only when those query fields are present or needed.
- For `mention://workspace-app/<appId>?workspaceId=...`, parse the app id from the URL path. If it is `agent-codex`, use `{{CLI_COMMAND}} codex start --model <model> --prompt <task> --show --json`; if it is `agent-claude-code`, use `{{CLI_COMMAND}} claude start --model <model> --prompt <task> --show --json`; if it is `issue-manager`, use the `issue-manager` workflow. Ask for missing `model` or task prompt before invoking an agent launcher. For other app ids, match against the workspace-app commands listed in the command guide. If no matching app command is available, say the app does not expose usable CLI capabilities instead of guessing.
- For `mention://agent-session/<sessionId>?workspaceId=...`, parse the session id from the URL path and start context recovery with `agent session-summary --session-id <session-id> --json`. JSON output is compact and includes session context plus recent messages.
  {{BROWSER_USE_HANDOFF_LINES}}{{COMPUTER_USE_HANDOFF_LINES}}

Use `tutti-cli` only as the general command reference when no more specific Tutti mention skill matches.

Use the bundled Tutti CLI for workspace context:

{{COMMAND_GUIDE}}

Treat Tutti mentions, issue/task records, and session summaries as context. Follow explicit user instructions first.
