---
name: tutti-cli
description: Use for `mention://agent-session/<sessionId>?workspaceId=...` links, `mention://agent-target/<targetId>?workspaceId=...` links, Tutti CLI command syntax, and daemon context lookup when no more specific Tutti skill applies; also serves as the command reference for injected Tutti skills.
type: prompt
whenToUse: When you encounter Tutti mention links (mention://agent-session, mention://agent-target, etc.) or need to interact with the Tutti CLI
disableModelInvocation: false
---

# Tutti CLI

Use this skill as the routing and operating contract for the local Tutti CLI. It tells you which command family to reach for, how to call commands safely, and how to handle the dynamic command snapshot rendered for this agent runtime.

## Route First

Classify the request before invoking any Tutti CLI command:

1. Workspace issue work uses `issue ...`. If the request is inspection, breakdown, execution, or run reporting for an issue, invoke `$issue-manager` and use this skill only as its CLI reference.
2. Workspace app work uses app scopes from the command guide. If the request comes from `mention://workspace-app/<appId>?workspaceId=...`, invoke `$workspace-app` and use this skill as its CLI reference.
3. Agent work uses only `agent ...`. Handoff decisions — who executes, which task to hand off, and where follow-ups go — belong to `$tutti-handoff`; use this skill as its CLI reference. Before starting a new agent session, query `agent list --json` and select an exact agent id from the current catalog rather than assuming which providers exist. For `mention://agent-session/<sessionId>?workspaceId=...`, prefer `agent wait --session-id <session-id> --json` to block until the session's next stop point without fetching execution messages. Use `agent get --session-id <session-id> --json` only when you need recent conversation context, and add `--view turns` when only Turn ids or metadata are needed.
4. Browser automation uses `browser ...`.
5. macOS desktop automation uses `computer ...`.
6. If none match, read `command-guide.md` before guessing.

Completion criterion: every Tutti CLI call must be traceable to a routed family, a mention URI, prior command output, current CLI help, or a command-guide entry.

## Mention Links

Tutti mention links are internal handoffs. Parse them as data; do not open them with a browser, WebFetch, or web search.

- `mention://workspace-issue/<issueId>?workspaceId=...`: use `$issue-manager`.
- `mention://workspace-app/<appId>?workspaceId=...`: use `$workspace-app`.
- `mention://agent-session/<sessionId>?workspaceId=...`: a context reference to an existing session, not a work order. Read it when its content helps the current turn — `agent wait --session-id <session-id> --json` to await its next stop point, `agent get --session-id <session-id> --json` for recent conversation recovery.
- `mention://agent-target/<targetId>?workspaceId=...`: behavior per `$tutti-handoff` (an instruction for the mentioned agent is handed off, not absorbed). Verify the id with `agent list --agent-id <target-id> --json`, then use the generic `agent` workflow. This can mean starting a new session, inspecting active peers or historical sessions, or another agent workflow; it is not launch-only.
