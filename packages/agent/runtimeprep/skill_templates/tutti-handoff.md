---
name: tutti-handoff
description: Use for any turn that mentions another agent (`mention://agent-target/...`) where work may move between agents, and for follow-up turns about work already handed to another agent session in this conversation — deciding whether to hand off, which task to hand off, how results come back, handling launch failures, and routing follow-up instructions after a delegation. A `mention://agent-session/...` link on its own is a context reference, not a handoff trigger.
---

# Tutti Agent Handoff

This skill is the handoff contract between agents: who executes, what gets handed off, how results return, and where follow-ups go. Use `$tutti-cli` for command syntax and the command guide; this skill decides behavior, not flags. When you report a handoff to the user, say it plainly — the selected agent name from the current agent catalog and its session id — and do not coin labels for it.

Before starting a new agent session, run `{{CLI_COMMAND}} agent list --json`. Select the exact agent id from the current result or verify the id carried by an `agent-target` mention. Do not choose from a memorized provider list, infer an id from a provider name, or assume that only a fixed set of built-in agents exists. Start the selected agent with `{{CLI_COMMAND}} agent start --agent-id <agent-id> --prompt <task> --show --json`.

{{AGENT_IMAGE_HANDOFF_GUIDANCE}}

## Decide Who Executes

When a message mentions another agent, decide who the message is addressed to before doing anything:

- Agent mention + an instruction ("@reviewer inspect this change"): the message is addressed to the mentioned agent — it executes. Package and hand off. Do not do the task yourself just because you can — the mention is the user's explicit choice of executor, and task difficulty is not a reason to override it.
- Agent mention that is only talked about ("the code @reviewer wrote last time"): no task transfers. Handle the turn yourself, reading the mentioned session as context if useful.
- A question about available agents or which agent fits a task: query the current agent list and answer from it. Do not start a session unless the user also asks for work to be handed off.

## Decide What to Hand Off

Which task to hand off follows the user's wording; when the wording is vague, work from candidates instead of guessing:

1. Enumerate candidates: the unfinished, user-initiated tasks in this conversation.
2. Match the user's wording against them — "continue" points at ongoing work, "this one" at the nearest, a name at the named task.
3. Exactly one fit: hand off and name your pick in the reply. Several fit: take the most recently active one, name it, and say in the handoff prompt that this pick is an assumption, naming the other open tasks. No fit, or you cannot choose: ask the user and list the candidates — do not ask open-endedly.

Filter out system behavior. Context compaction, session title or summary generation, retries and replays, harness system prompts, and permission interactions are not user tasks. Never hand them off and never treat them as the task — skip such entries and pick the user task before them. A summary or redo the user explicitly asks for is a user task, not system behavior.

## Decide How Results Return

Decide from the user's intent how results should return, before starting anything:

- Delegate (fire-and-forget): start the session, save and report the session id (follow-ups will need it), and let the current conversation move on. Do not block on completion.
  {{AGENT_FETCH_GUIDANCE}}
- Collaborate (parallel work with a peer): state each side's boundary in the handoff prompt, keep outputs mergeable, and do not edit the files the peer session is working on while it runs.

## Wait Discipline After Delegating

{{AGENT_WAIT_DISCIPLINE_GUIDANCE}}

## Handle Launch Failures

After starting or messaging an agent, confirm it succeeded (session id / ack) and report it. If starting fails or the selected agent is unavailable, report the selected agent id and failure reason, refresh the current catalog with `{{CLI_COMMAND}} agent list --json`, then offer retrying, another currently available agent, or doing the work here yourself. If messaging an existing session fails, report that session id and failure reason. Do not silently do the task yourself, and do not silently drop it.

## Route Follow-ups After a Handoff

Once a task is handed to a session, the task stays with that session:

- Increments ("oh, and make the button blue") and rework ("have it redo this without breaking the mobile layout") go to the same session via `{{CLI_COMMAND}} agent send`, carrying the user's feedback. Do not start a new session and do not make the change yourself.
- A repeated mention with a duplicate instruction: check existing sessions first (this conversation's own record, `{{CLI_COMMAND}} agent sessions` or `{{CLI_COMMAND}} agent active-peers --json`) and message the existing session instead of starting a duplicate.

## Completion Criterion

Every handoff turn must be traceable to: who executes, which task, how results return, and — after any delegation — one session that all follow-ups go to.
