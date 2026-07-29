# AGENTS.md

## Scope

This file applies to `packages/agent/gui/*`.

Read the repository root `AGENTS.md` and `packages/AGENTS.md` first. This file
adds AgentGUI-specific guardrails.

## Required Reading

Before planning or editing AgentGUI, AgentGuiNode, or the agent conversation
module, read this architecture document first:

- [docs/architecture/agent-gui-node.md](../../../docs/architecture/agent-gui-node.md)

When changing `AgentActivityRuntime`, `agent-activity-core`, workspace engine,
event/reconcile behavior, package exports, or a host adapter, also read the
package/activity boundary document:

- [docs/architecture/agent-activity-packages.md](../../../docs/architecture/agent-activity-packages.md)

For composer file references or mention behavior, also read the relevant
reference architecture:

- [Agent Reference Sources](../../../docs/architecture/agent-reference-sources.md)
- [docs/architecture/agent-reference-mention-resolution.md](../../../docs/architecture/agent-reference-mention-resolution.md)

## AgentGUI Rules

- Treat `AgentActivityRuntime` as the production source for agent activity data
  and commands.
- Keep `AgentHostApi` usage limited to host capabilities such as files,
  clipboard, account/project lookup, Agent Target setup/probes, diagnostics,
  and local helper flows.
- Treat Session, Turn, Interaction, Goal, and operation state as canonical
  domain facts. Transcript rows and React component state are not lifecycle
  authority.
- Use exact workspace/session/turn/request/target identity. Do not infer it from
  provider names, titles, timestamps, array position, or the latest row.
- Keep shared behavior provider-neutral: consume descriptor, strategy, and
  capability contracts rather than branching on provider names.
- Trace the full chain before fixing a local AgentGuiNode symptom: activation,
  selected session, session list, timeline, composer, submit, approval,
  interactive prompt, provider capability, generated files, mention resolution,
  or layout.
- Prefer pure model/projection helpers and focused controller helpers over
  adding orchestration to React components.
- After any AgentGUI fix, feature, extraction, or flow refactor, run the root
  documentation-impact and `Self-Evolution Notes` checks. Data-flow,
  interaction-state, loading, resume, send, approval, timeline, or ownership
  changes usually update
  [docs/architecture/agent-gui-node.md](../../../docs/architecture/agent-gui-node.md);
  recurring symptoms usually update
  [Agent Runtime Troubleshooting](../../../docs/conventions/troubleshooting/agent-runtime.md).
- When a fix captures a recurring AgentGuiNode debugging trap, record the
  lesson in the matching durable doc when it is in scope, or ask the user first
  if adding the note would broaden the requested change:
  [docs/architecture/agent-gui-node.md](../../../docs/architecture/agent-gui-node.md)
  or [Agent Runtime Troubleshooting](../../../docs/conventions/troubleshooting/agent-runtime.md).

## Checks

Follow the repository [Validation Selection](../../../docs/conventions/testing.md#validation-selection).
AgentGUI adds one domain-specific supplement: run
`pnpm check:agent-provider-strategy-boundaries` when provider strategy or
capability contracts change and the changed-aware plan does not select it.
