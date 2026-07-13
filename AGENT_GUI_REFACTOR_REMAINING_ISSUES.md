# AgentGUI Refactor Remaining Issues

Status: resolved on the AgentGUI refactor branch.

This document now preserves the original handoff findings as a completion
record. The durable design remains in `docs/architecture/agent-gui-node.md`.

## Resolution summary

| Original issue                        | Resolution                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Activity boundary false positive      | The checker follows the actual `useSyncExternalStore` argument dependency and has pass/fail fixtures. |
| Static and live Workbench directories | One live directory port drives body, dock, validation, and handoff.                                   |
| Detached-window second directory      | Full lifecycle snapshot hydration plus canonical service subscription/refresh.                        |
| Oversized Desktop orchestration       | Tool panels and activity query/import capabilities were extracted behind focused boundaries.          |
| Implicit directory lifecycle          | Explicit `idle/loading/ready/error`, retained cache, and service-owned retry.                         |
| Public AgentGUI dual target props     | One directory snapshot; normalized target/rail inputs are no longer caller-writable.                  |
| DOM-ref queued image loading          | Explicit request owner with complete identity and stale-result cancellation.                          |
| Shallow locale extraction             | Complete English and Chinese `agentGui` subtrees are vertical locale modules.                         |
| Missing changed-aware boundary lane   | Relevant package, Desktop, checker, and fixture changes schedule the lane.                            |
| Obsolete Workbench loader             | Interface, implementation, subscription, and tests were removed.                                      |
| Source-text startup regression test   | Live directory behavior is tested without contribution recomposition.                                 |
| Dual carousel image owners            | One decoded-image load owner feeds a GPU-only Three.js scene.                                         |
| Removed-file degradation exemption    | Stale entry removed; checker now rejects nonexistent exemptions.                                      |

The issue descriptions below are the original evidence retained for audit
history; they no longer describe the current implementation.

## Recommended order

1. Fix the P0 boundary checker so the branch can pass the full validation gate.
2. Converge the live agent-directory seam across shared Workbench, Desktop, and
   detached windows.
3. Remove the public AgentGUI dual input and the obsolete directory loader.
4. Move queued-image and carousel asset lifetimes behind explicit owners.
5. Complete the locale split and changed-aware validation coverage.

## P0

### Agent activity boundary checker reports a false violation

`tools/scripts/check-agent-activity-runtime-boundaries.mjs` currently treats a
file containing both `getSessionEngine` and `useSyncExternalStore` as a direct
session-engine subscription. `workspaceAgentGuiContribution.ts` uses
`useSyncExternalStore` for `agentsService` and separately reads the session
engine through selectors, so the check fails even though the subscribed object
is not the engine.

Impact:

- `pnpm check:agent-activity-runtime-boundaries` fails.
- The check is part of `check:full`, so the current branch cannot pass the full
  repository gate.

Required fix:

- Make the checker inspect the actual subscribed expression/call relationship
  rather than file-level token coexistence.
- Add fixtures proving that an unrelated `agentsService` subscription passes
  and a direct engine subscription fails.
- Do not fix this by merely moving one expression to another file.

## P1

### Shared Workbench still has static and live agent-directory paths

`packages/agent/gui/workbench/contribution.ts` still accepts static
`agents/agentsLoading`, while Desktop passes `agents: undefined` and uses
`agentsService` plus `resolveDockLaunchPayload` for live data. This disables the
shared launch guard for missing `agentTargetId` outside the dock-empty path.

Required fix:

- Replace the static/dynamic dual path with one neutral live agent-directory
  port whose snapshot drives dock payloads, launch validation, detached-window
  handoff, and body rendering.

### Detached Agent window owns a second agent directory

`StandaloneAgentWindow.tsx` copies `IAgentsService.load()` results into React
state and reloads on focus instead of subscribing to the canonical service.
The opener transfers only an `agents` array, so it loses loading/error metadata
and can interpret an initial empty array as a completed empty directory.

Required fix:

- Hydrate the full directory snapshot and subscribe to the single
  `IAgentsService` source in the detached window.
- Remove focus-owned reload state after the service owns refresh policy.

### Latest main adds oversized Agent desktop orchestration files

After the current main merge,
`StandaloneAgentToolSidebar.tsx` is above 900 lines and
`workspaceAgentActivityService.ts` remains above the repository's 800-line
business-code limit. The former combines tool layout, Message Center engine
projection/commands, message prefetch, and browser/terminal panel composition;
the latter still combines the public activity facade with several import and
runtime operations.

Required fix:

- Extract the standalone Message Center vertical and the individual tool-panel
  composition without moving canonical session/turn state out of the shared
  `AgentSessionEngine`.
- Continue decomposing the desktop activity facade by capability while keeping
  reconciliation and engine ownership centralized in the existing bridge/host
  modules.
- Add behavioral tests at the extracted boundaries; do not replace the files
  with source-text-only checks.

### Agent directory loading has no explicit lifecycle

`AgentsSnapshot.capturedAtUnixMs === null` currently represents idle, loading,
and failed states. An initial load failure is swallowed by the shell hook and
does not publish a new snapshot, so the composer may remain in loading state
until a later focus-triggered retry.

Required fix:

- Give `IAgentsService` explicit idle/loading/ready/error state.
- Publish failures while retaining the last successful directory.
- Centralize retry/refresh policy in the service.

### Public AgentGUI props expose two writable target seams

`AgentGUIProps` uses `Omit<AgentGUINodeProps, "agents">`, but `AgentGUINodeProps`
does not define `agents`, so the omission is ineffective. Callers can still set
the older `hostCapabilities.agentTargets`, loading, and provider-rail fields
while also setting flat `agents/agentsLoading`; the implementation silently
overwrites one set.

Required fix:

- Narrow the public wrapper types so normalized target/rail internals are not
  caller-writable.
- Keep one public agent-directory input consistent with the architecture doc.

### Queued image loading is hidden in a DOM callback ref

`AgentQueuedPromptPanel.tsx` starts activity-runtime asset reads from a callback
ref and keys in-flight state without runtime/workspace/session identity. Failed
or context-switched loads can be permanently suppressed, and DOM connectivity
is being used as the cancellation protocol.

Required fix:

- Introduce a focused queued-prompt asset-loading owner with a complete request
  identity and explicit stale/cancel behavior.
- Keep React responsible for rendering the resulting snapshot rather than
  hiding async orchestration in a ref commit.

### AgentGUI locale extraction is too shallow

The slash-palette extraction moves only a handful of keys while `en.ts` and
`zh-CN.ts` remain very large. The complete `agentGui` locale subtree is a more
useful vertical module seam.

Required fix:

- Extract the full AgentGUI locale subtree per locale, keeping each resulting
  file below the repository business-code size limit where applicable.
- Remove or reduce the corresponding degradation exemptions when possible.

### Changed-aware checks omit the activity runtime boundary lane

`tools/scripts/run-check-changed.mjs` does not schedule
`check:agent-activity-runtime-boundaries` for AgentGUI, activity-core, or
Desktop workspace-agent/workbench changes. The P0 above is therefore found
only by the full gate.

Required fix:

- Add a changed-aware lane for the relevant package, Desktop, and checker paths.
- Update `docs/conventions/static-analysis.md` with the trigger contract.

## P2

### Obsolete Workbench agent-directory loader remains

`loadAgentGuiAgents()`, `AgentGuiAgentsLoader`, and their host cache/invalidation
subscription no longer have production callers. They preserve a second loading
model and the subscription is not disposed with the host.

Required fix:

- Delete the interface method, implementation, loader, subscription, and stale
  tests as one cleanup.

### Workbench startup regression test is source-text based

The current regression test asserts source patterns instead of constructing a
host session, emitting from `agentsService`, and verifying stable composition
identity with updated dock/body snapshots.

Required fix:

- Add a behavioral test for live directory updates without host recomposition.

### Carousel still has two image-loading owners

`AgentGUIHeroAgentCarousel` preloads and decodes images, while
`AgentGuiHeroCarouselScene` still creates and owns fallback image loaders for
missing entries. Failure retries and disposal are split across two modules.

Required fix:

- Choose one owner for network image loading and GPU texture lifetime. Prefer a
  deep scene adapter contract or require the scene to receive decoded images.

### Degradation baseline contains a removed-file exemption

`tools/degradation-baseline/agent-gui.json` still lists the removed
`packages/agent/gui/providerTargets.ts` path.

Required fix:

- Remove the stale exemption and make the checker reject exemptions for files
  that no longer exist.

## Validation status at handoff

Passed during this phase:

- AgentGUI degradation check.
- Provider catalog generation/boundary tests.
- AgentGUI package tests (136 files, 1,891 tests).
- Agent activity core tests (152 tests).
- Targeted provider registry and `service/agent` Go tests after the current
  descriptor/reasoning projection changes.
- Targeted Workbench dock-state and host-service tests (29 tests).

Known failing check:

- `pnpm check:agent-activity-runtime-boundaries` fails for the P0 false positive
  documented above.

Repository-wide bulk validation was intentionally deferred for this merge
cycle because main is changing concurrently and will require another conflict
resolution pass.
