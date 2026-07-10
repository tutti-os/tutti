# AGENTS.md

## Scope

This file applies to `packages/agent/gui/*`.

Read the repository root `AGENTS.md` and `packages/AGENTS.md` first. This file
adds AgentGUI-specific guardrails.

## Required Reading

Before planning or editing AgentGUI, AgentGuiNode, or the agent conversation
module, read this architecture document first:

- [docs/architecture/agent-gui-node.md](../../../docs/architecture/agent-gui-node.md)

Then read the package/activity boundary document:

- [docs/architecture/agent-activity-packages.md](../../../docs/architecture/agent-activity-packages.md)

For composer file references or mention behavior, also read the relevant
reference architecture:

- [Agent Reference Sources](../../../docs/architecture/agent-reference-sources.md)
- [docs/architecture/agent-reference-mention-resolution.md](../../../docs/architecture/agent-reference-mention-resolution.md)

## AgentGUI Rules

- Treat `AgentActivityRuntime` as the production source for agent activity data
  and commands.
- Keep `AgentHostApi` usage limited to host capabilities such as files,
  clipboard, account/project lookup, diagnostics, and local helper flows.
- Trace the full chain before fixing a local AgentGuiNode symptom: activation,
  selected session, session list, timeline, composer, submit, approval,
  interactive prompt, provider capability, generated files, mention resolution,
  or layout.
- Prefer pure model/projection helpers and focused controller helpers over
  adding orchestration to React components.
- After any AgentGUI or AgentGuiNode fix, feature, module extraction, or flow
  refactor, run the documentation impact and self-evolution prompt in
  [docs/architecture/agent-gui-node.md](../../../docs/architecture/agent-gui-node.md):
  decide `discard`, `improve`, `merge`, or `create`; prefer improving existing
  lessons over adding duplicates; remove instance-specific or sensitive details
  before proposing any durable note. For any decision except `discard`, update
  the corresponding durable document in the same change. Data-flow,
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

After changing AgentGUI data flow, run:

```sh
pnpm check:agent-activity-runtime-boundaries
```

For focused package changes, prefer:

```sh
pnpm --filter @tutti-os/agent-gui test
```

Use `pnpm check:changed` before handing off mixed AgentGUI, desktop workbench,
or host adapter changes.
