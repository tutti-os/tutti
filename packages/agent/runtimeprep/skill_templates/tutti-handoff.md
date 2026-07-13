---
name: tutti-handoff
description: Use for any turn that mentions another agent (`mention://agent-target/...` or `mention://agent-session/...`) where work may move between agents, and for follow-up turns about work already handed to another agent session in this conversation — deciding whether to hand off, which task to hand off, how results come back, handling launch failures, and routing follow-up instructions after a delegation.
---

# Tutti Agent Handoff

This skill is the handoff contract between agents: who executes, what gets handed off, how results return, and where follow-ups go. Use `$tutti-cli` for command syntax and the command guide; this skill decides behavior, not flags. When you report a handoff to the user, say it plainly — the agent name and its session id (e.g. "Handed off to Claude Code — session id: ...") — and do not coin labels for it.

## Decide Who Executes

When a message mentions another agent, decide who the message is addressed to before doing anything:

- Agent mention + an instruction ("@codex look up today's trending topics"): the message is addressed to the mentioned agent — it executes. Package and hand off. Do not do the task yourself just because you can — the mention is the user's explicit choice of executor, and task difficulty is not a reason to override it.
- Agent mention that is only talked about ("the code @codex wrote last time"): no task transfers. Handle the turn yourself, reading the mentioned session as context if useful.
- A question about the mentioned agent itself ("which of @codex and @claude is better for frontend work"): answer directly. Do not start a session or send anything.

## Decide What to Hand Off

Which task to hand off follows the user's wording; when the wording is vague, work from candidates instead of guessing:

1. Enumerate candidates: the unfinished, user-initiated tasks in this conversation.
2. Match the user's wording against them — "continue" points at ongoing work, "this one" at the nearest, a name at the named task.
3. Exactly one fit: hand off and name your pick in the reply. Several fit: take the most recently active one, name it, and say in the handoff prompt that this pick is an assumption, naming the other open tasks. No fit, or you cannot choose: ask the user and list the candidates — do not ask open-endedly.

Filter out system behavior. Context compaction, session title or summary generation, retries and replays, harness system prompts, and permission interactions are not user tasks. Never hand them off and never treat them as the task — skip such entries and pick the user task before them. A summary or redo the user explicitly asks for is a user task, not system behavior.

## Decide How Results Return

Decide from the user's intent how results should return, before starting anything:

- Delegate (fire-and-forget): start the session, save and report the session id (follow-ups will need it), and let the current conversation move on. Do not block on completion.
- Fetch (results must come back): read the peer session with `{{CLI_COMMAND}} agent session-summary --session-id <session-id> --json` instead of starting new work there. When you delegate work whose output you must consume, request machine-consumable output, then use the retrieved result to continue the current task — retrieval is not complete until the result is applied.
- Collaborate (parallel work with a peer): state each side's boundary in the handoff prompt, keep outputs mergeable, and do not edit the files the peer session is working on while it runs.

## Handle Launch Failures

After starting or messaging an agent, confirm it succeeded (session id / ack) and report it. If the launch fails or the provider is unavailable (not installed, auth expired), tell the user what failed and offer options: retry, another agent, or doing it here yourself. Do not silently do the task yourself, and do not silently drop it.

## Route Follow-ups After a Handoff

Once a task is handed to a session, the task stays with that session:

- Increments ("oh, and make the button blue") and rework ("have it redo this without breaking the mobile layout") go to the same session via `{{CLI_COMMAND}} agent send`, carrying the user's feedback. Do not start a new session and do not make the change yourself.
- A repeated mention with a duplicate instruction: check existing sessions first (this conversation's own record, `{{CLI_COMMAND}} agent sessions` or `{{CLI_COMMAND}} agent active-peers --json`) and message the existing session instead of starting a duplicate.

## Completion Criterion

Every handoff turn must be traceable to: who executes, which task, how results return, and — after any delegation — one session that all follow-ups go to.
