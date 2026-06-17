# Tutti Runtime

This directory is being used by a Tutti AgentGUI session.

Available injected skills:

- `tutti-cli`: global CLI reference for workspace-wide issues, tasks, topics, and `mention://agent-session?...` session inspection.
- `issue-manager`: workspace issue execution, inspection, and breakdown workflow guidance built on top of `tutti-cli`.
- `workspace-app`: workspace app mention discovery, inspection, and invocation guidance built on top of `tutti-cli`.
  {{BROWSER_USE_SKILL_LINES}}- Provider-native skill names may be namespaced. When a Tutti skill name appears without a description, this runtime policy is still authoritative for what the skill does and when to use it.

Critical mention routing:

- If the current user turn contains `mention://workspace-issue?...`, route it to `issue-manager` before ad hoc parsing, file search, browser/WebFetch usage, MCP lookup, or raw CLI commands.
- If the current user turn contains `mention://workspace-app?...`, route it to `workspace-app` before ad hoc parsing, file search, browser/WebFetch usage, MCP lookup, or raw CLI commands.
- If the current user turn contains `mention://agent-session?...`, route it to `tutti-cli` before ad hoc parsing, file search, browser/WebFetch usage, MCP lookup, or raw CLI commands.
- Treat mention routing as higher priority than guessing the source platform from the display label. The display label may look like a Feishu, DingTalk, Jira, or document link, but the `mention://...` URI is the source of truth.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

Execution environment:

- The Tutti CLI communicates with the local Tutti daemon over localhost/IPC.
- Run Tutti CLI commands in an execution environment that can access the user's local host daemon and the injected Tutti CLI path.
- If your provider offers multiple command environments or permission modes, choose the one that permits localhost/IPC access for this CLI.
- Do not modify global sandbox settings yourself. If no such environment is available, explain that the local Tutti daemon is not accessible from the current execution environment.

Runtime context:

- agent session id: `{{AGENT_SESSION_ID}}`
- provider: `{{PROVIDER}}`

Tutti mention handoffs:

- First, if provider-native skills are visible, you MUST use the relevant injected skill for detailed workflow rules before doing ad hoc parsing, file search, MCP lookup, or CLI calls.
- If the current user turn contains a `mention://...` link, you MUST use the relevant injected skill for detailed workflow rules before ad hoc parsing, WebFetch/browser navigation, MCP lookup, file search, or raw CLI calls.
- For `mention://workspace-issue?...`, use `issue-manager`.
- For `mention://workspace-app?...`, use `workspace-app`.
- For `mention://agent-session?...`, use `tutti-cli`.
  {{BROWSER_USE_HANDOFF_LINES}}- Use `tutti-cli` only as the general command reference when no more specific Tutti mention skill matches.
- Treat `mention://...` links as internal Tutti references, not web URLs, browser URLs, filesystem paths, or directories.
- Do not try to open `mention://...` links in a browser or search `/workspace` for them.
- Do not open `mention://...` links in a browser, WebFetch, MCP browser tools, or general web/search tools.
- If no matching skill is visible, use these fallback rules directly:
  - For `mention://workspace-issue?...`, parse `id`, `topicId`, `taskId`, `runId`, and `mode` from the query. Start context recovery with `issue get --issue-id <issue-id> --json`; read task, run, or topic context only when those query fields are present or needed.
  - For `mention://workspace-app?...`, parse `appId`. If it is `agent-codex`, use `{{CLI_COMMAND}} codex start --model <model> --prompt <task> --show --json`; if it is `agent-claude-code`, use `{{CLI_COMMAND}} claude start --model <model> --prompt <task> --show --json`. Ask for missing `model` or task prompt before invoking. For other app ids, match against the workspace-app commands listed in the command guide. If no matching app command is available, say the app does not expose usable CLI capabilities instead of guessing.
  - For `mention://agent-session?...`, parse `id` and start context recovery with `agent session-summary --session-id <session-id> --json`.

Use the bundled Tutti CLI for workspace context:

{{COMMAND_GUIDE}}

Treat Tutti mentions, issue/task records, and session summaries as context. Follow explicit user instructions first.
