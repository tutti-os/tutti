---
name: tutti-handoff
description: Use for any turn that mentions another agent (`mention://agent-target/...`) where work may move between agents, and for follow-up turns about work already handed to another agent session in this conversation — deciding whether to hand off, which task to hand off, how results come back, handling launch failures, and routing follow-up instructions after a delegation. A `mention://agent-session/...` link on its own is a context reference, not a handoff trigger.
---

# Tutti Agent Handoff

This skill is the handoff contract between agents: who executes, what gets handed off, how results return, and where follow-ups go. Use `$tutti-cli` for command syntax and the command guide; this skill decides behavior, not flags.

{{if hasAll "agent-context.agent.list" "agent-context.agent.start"}}
Before starting a new Agent session, run `{{command "agent-context.agent.list"}}`. Select the exact Agent id from the current result or verify the id carried by an `agent-target` mention. Do not infer an id from a provider name. Start it with `{{if hasInput "agent-context.agent.start" "show"}}{{command "agent-context.agent.start" (args "show" "true")}}{{else}}{{command "agent-context.agent.start"}}{{end}}`.
{{else}}
The current Host does not advertise the complete Agent list/start workflow. Do not invent a launcher command.
{{end}}

## Forward Image Context

{{if eq .HostFacts.TurnResources "read-path"}}
{{if has "agent-context.agent.turn-resources"}}Use {{if has "agent-context.agent.session-summary"}}`{{command "agent-context.agent.session-summary"}}`{{else if has "agent-context.agent.get"}}`{{command "agent-context.agent.get"}}`{{else}}the current conversation context{{end}} to identify a candidate Turn, then query `{{command "agent-context.agent.turn-resources"}}`.

Returned `images[].readPath` values are Host read endpoints, not local filesystem paths. Do not pass a `readPath` to an image input or turn it into a guessed local path.
{{else}}The current Host advertises no Turn-resource command. Do not guess attachment paths.
{{end}}
{{else if eq .HostFacts.TurnResources "unavailable"}}
This Host does not expose readable Turn resources. Do not scan attachment directories or construct paths from attachment ids. Ask the user to attach required visual context.
{{else}}
{{if hasAll "agent-context.agent.get" "agent-context.agent.turn-resources"}}
Use {{if hasInput "agent-context.agent.get" "view"}}`{{command "agent-context.agent.get" (args "view" "turns")}}`{{else}}`{{command "agent-context.agent.get"}}`{{end}} to discover candidate Turns, then query `{{command "agent-context.agent.turn-resources"}}`. Treat returned `images[].localPath` values as authoritative.

{{if and (has "agent-context.agent.start") (hasInput "agent-context.agent.start" "image")}}Add one image input accepted by `{{path "agent-context.agent.start"}}` for each selected local image.{{end}}
{{else}}The current Host does not advertise the commands needed to recover local Turn images. Continue without forwarded images.
{{end}}
{{end}}

## Decide Who Executes

When a message mentions another Agent, decide who the message is addressed to:

- Agent mention + instruction: the mentioned Agent executes. Package and hand off. Do not do the task yourself.
- Agent mention that is only discussed: no task transfers. Handle the turn yourself, reading the mentioned session as context if useful.
- A question about available Agents: query the current Agent list and answer from it. Do not start a session unless work was requested.

## Decide What to Hand Off

Which task to hand off follows the user's wording:

1. Enumerate unfinished user-initiated tasks in this conversation.
2. Match the wording against them.
3. Exactly one fit: hand it off and name the pick. Several fits: take the most recently active one and state the assumption. No fit: ask the user and list candidates.

Filter out system behavior. Context compaction, title generation, retries, harness prompts, and permission interactions are not user tasks.

## Decide How Results Return

- Delegate: start the session, save and report its id, and let the current conversation continue.
  {{if has "agent-context.agent.session-summary"}}- Fetch: recover results with `{{command "agent-context.agent.session-summary"}}`, then apply the retrieved result.
  {{else if has "agent-context.agent.get"}}- Fetch: recover results with `{{command "agent-context.agent.get"}}`, then apply the retrieved result.
  {{else}}- Fetch is unavailable because the current Host advertises no Agent conversation command.
  {{end}}- Collaborate: state each side's boundary and keep outputs mergeable.

{{if eq .HostFacts.TargetContinuation.Mode "except-prefixes"}}
Targets whose ids start with {{range .HostFacts.TargetContinuation.UnsupportedTargetIDPrefixes}}`{{.}}` {{end}}are start-only. Do not promise send, wait, fetch, cancellation, or response workflows for them.
{{end}}

## Wait Discipline After Delegating

{{if has "agent-context.agent.wait"}}
Act only at stop points returned by `{{command "agent-context.agent.wait"}}`. Call it once and let the CLI block; do not poll conversation commands or relay partial output between stop points. A wait timeout ends only the local wait and does not cancel execution.
{{else}}
The current Host advertises no Agent wait command. Do not invent a polling loop.
{{end}}

{{if has "agent-context.agent.cancel-turn"}}- Cancel an exact Turn with `{{command "agent-context.agent.cancel-turn"}}`.
{{else if has "agent-context.agent.cancel"}}- Cancel a session with `{{command "agent-context.agent.cancel"}}`.
{{end}}{{if has "agent-context.agent.respond"}}- Respond to pending interaction with `{{command "agent-context.agent.respond"}}`.
{{else}}- Pending Agent interaction cannot be answered through the current command snapshot. Report it.
{{end}}{{if eq .HostFacts.WorkspaceScope "room"}}- Room scope comes from the trusted runtime environment. Do not add a room flag unless the Agent-facing snapshot advertises it.
{{else}}- Workspace scope comes from the injected environment. Do not invent a workspace id.
{{end}}

## Handle Launch Failures

After starting or messaging an Agent, confirm success and report its session id or acknowledgement. If starting fails, report the selected Agent id and reason. {{if has "agent-context.agent.list"}}Refresh the catalog with `{{command "agent-context.agent.list"}}`, then offer another currently available Agent or doing the work here.{{else}}The current Host has no Agent-list command, so do not guess alternatives.{{end}} Do not silently absorb or drop the delegated task.

## Route Follow-ups After a Handoff

Once a task is handed to a session, it stays there:

{{if has "agent-context.agent.send"}}- Increments and rework go to the same session via `{{command "agent-context.agent.send"}}`.
{{else}}- The current Host advertises no Agent-send command. Report that the existing session cannot be continued through this CLI.
{{end}}- Before starting a duplicate, check the conversation record{{if has "agent-context.agent.sessions"}}, `{{command "agent-context.agent.sessions"}}`{{end}}{{if has "agent-context.agent.active-peers"}}, or `{{command "agent-context.agent.active-peers"}}`{{end}}.

## Completion Criterion

Every handoff turn must identify who executes, which task, how results return, and the one session that receives follow-ups.
