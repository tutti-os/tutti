# Tutti Mode Explicit Guidance Routing Remediation

- Status: confirmed and implemented
- Baseline: `origin/main`
- Date: 2026-08-12

## Background and Goal

While a Tutti Plan is executing, an ordinary Composer Send is automatically
converted to guidance when the Plan has non-terminal work, the current Turn is
running, and the provider advertises `activeTurnGuidance`. That routing treats
a capability as user intent, so ordinary messages, `/compact`, and `/goal` can
bypass normal queueing or control-command parsing in a timing-dependent way.

The goal is for ordinary Send to preserve ordinary submit semantics and use the
existing prompt queue while busy. Guidance must require an explicit guidance
action. The completed-Goal active projection and the source of a later
`goal/set` are separate follow-ups once sufficient evidence exists.

## Current and Target Flows

Current flow:

```text
ordinary Send
  -> submitPromptOrDecidePlan
  -> Plan active + Turn running + activeTurnGuidance === true
  -> submitGuidancePrompt(sendNow=true, targetTurnId)
  -> routing=send_now
  -> GuideActiveTurn
```

Target flow:

```text
ordinary Send
  -> submitPromptOrDecidePlan
  -> submitPrompt
  -> routing=auto
  -> send while idle, otherwise wait in the existing prompt queue

explicit Guidance
  -> submitGuidancePrompt
  -> routing=send_now + targetTurnId
  -> GuideActiveTurn
```

## Module Changes

| Module                              | Change                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAgentGUITuttiWorkflow.ts`       | Remove automatic guidance from ordinary Send during active Plan execution. After Plan Review feedback handling, always call ordinary submit. |
| `AgentGUIDetailPane.tsx`            | Remove the unused Workflow guidance passthrough input while preserving the Composer's explicit `onSubmitGuidance`.                           |
| `useAgentGUITuttiWorkflow.spec.tsx` | Replace the automatic-steer expectation with active-execution coverage for ordinary text, `/compact`, and `/goal clear`.                     |
| `agent-gui-node.md`                 | Record that provider capability enables explicit guidance but never changes ordinary Send semantics.                                         |

No API, persistence schema, queue, or provider adapter is added. The change
reuses the existing prompt queue, typed Goal control, explicit guidance path,
and runtime capability.

## Explicit Non-Goals

- Do not remove the underlying guidance capability.
- Do not make slash commands send-now by default.
- Do not implicitly interrupt the current Turn.
- Do not rewrite the Engine or provider runtime.
- Do not translate Goal `complete` into `clear` automatically.
- Do not change Goal continuation without source evidence.

## Compatibility, Risk, and Rollback

There is no data migration or protocol change. The main behavior risk is that
users who relied on ordinary text to correct the current Turn immediately will
now see that text queued. Immediate correction remains available through
explicit guidance. Tutti Mode Plan Review, Issue materialization, task
scheduling, Stop, recovery, and archival flows are unchanged.

Rollback restores only the Workflow routing and its tests/documentation; it
does not affect persisted data.

## Test and Acceptance Criteria

- With an active Plan, running Turn, and guidance support, ordinary text uses
  ordinary submit.
- Under the same state, `/compact` uses ordinary submit and waits in the queue
  while busy instead of becoming implicit guidance.
- Under the same state, `/goal clear` reaches typed Goal control through the
  ordinary submit path.
- Explicit guidance continues to carry `routing=send_now` and the exact
  `targetTurnId`.
- AgentGUI typecheck, formatting, degradation checks, and focused tests pass.

End-to-end acceptance focuses on the Composer-to-Engine routing boundary:
ordinary inputs do not create guidance, while explicit guidance still does.
Real-provider log verification follows in a staged build because no existing
Electron replay fixture combines an active Tutti Plan with an active source
Turn.
