# Workbench Contributions

This document defines the current compatible extension model for
`@tutti-os/workbench-surface`.

The goal is to let hosts move from one large, centralized workbench host
assembly layer toward feature-owned workbench contributions without breaking
existing consumers that already integrate `WorkbenchHost` directly.

## Problem Summary

`WorkbenchHost` currently exposes a flat host API:

- `nodes`
- `dockEntries`
- `externalStateSource`
- `onLaunchRequest`
- `onNodeCloseRequest`
- `snapshotRepository`
- other host shell inputs such as `workspaceId`, `missionControl`, and layout
  constraints

That API is still valid and should remain the primary public integration model
for current consumers. It works well for small hosts and for hosts that want
one composition root.

The pressure appears when a host grows multiple reusable workbench capabilities:

- browser node integration
- terminal node integration
- issue-manager integration
- files node integration
- future agent, preview, search, or provider-owned nodes

Without another composition layer, hosts tend to accumulate one increasingly
large assembly service that owns:

- node definitions
- dock entry wiring
- external state composition
- launch dispatch
- close-policy dispatch
- package-specific host adapters

That assembly style becomes harder to maintain, but replacing the current
`WorkbenchHost` props with a new required model would break downstream
consumers.

## Decision

`WorkbenchHost` accepts an optional `contributions` input while preserving the
explicit host props and their behavior.

`contributions` are an additive composition mechanism, not a replacement host
API.

Compatibility rule:

- existing `WorkbenchHost` integrations must continue to work without code
  changes
- existing explicit props remain supported and keep their current semantics
- `contributions` are optional and may be adopted incrementally

New workbench modules should default to
contribution-based integration. Direct top-level `nodes`, `dockEntries`,
`externalStateSource`, `onLaunchRequest`, and `onNodeCloseRequest` wiring should
be reserved for compatibility, host-wide policy, or deliberately simple shells.

## Design Goals

The contribution model should:

1. preserve backward compatibility for current `WorkbenchHost` consumers
2. let feature-owning packages participate in workbench integration without
   forcing all assembly back into one app-level host service
3. keep host-specific business policy, preload access, and daemon adapters in
   the consuming host
4. make merge behavior deterministic and easy to explain to downstream users
5. keep `workbench-surface` free of product-specific workflow knowledge

## Non-Goals

This change does not try to:

- remove or deprecate the flat `WorkbenchHost` prop model
- move preload APIs, Electron globals, `tuttid` clients, or host-specific
  transport wiring into shared packages
- make workbench contributions responsible for top-level shell concerns such as
  `snapshotRepository`, `workspaceId`, `missionControl`, or layout constraints
- force simple or compatibility consumers to use contributions

## Ownership Boundaries

### `packages/workbench/surface`

`workbench-surface` should own:

- the contribution type contract
- normalization and merge helpers
- deterministic composition rules between explicit host props and
  contributions
- deterministic composition for host-wide close preparation contributed by
  workbench modules
- default runtime behavior after configuration is resolved

It should not own:

- desktop-specific preload or Electron details
- `tuttid` client construction
- product copy overrides
- app-specific diagnostics sinks
- host-specific business close or reuse policy

### Capability-owning packages

Packages such as:

- `@tutti-os/browser-node`
- `@tutti-os/workspace-terminal`
- `@tutti-os/workspace-issue-manager`

may expose feature-specific workbench contribution factories when the shared
capability already owns reusable node or dock behavior.

Those packages may own:

- workbench node definitions for the capability
- dock entries for the capability
- capability-local external state shaping
- capability-local launch helpers
- capability-local close-policy hooks

They must not own:

- host globals such as `window.tutti`
- preload surface assumptions
- app-specific daemon client creation
- product-specific enablement or routing policy

### Consuming hosts such as `apps/desktop`

The consuming host should continue to own:

- host adapter construction
- daemon clients and preload wiring
- product policy such as feature enablement or access rules
- top-level shell inputs such as `snapshotRepository`, `workspaceId`,
  `missionControl`, and layout constraints
- any product-local contributions that do not yet have a real shared boundary

## Public Shape

The current `WorkbenchHostProps` shape includes one optional composition field:

```ts
export interface WorkbenchContribution {
  id: string;
  nodes?: readonly WorkbenchHostNodeDefinition[];
  dockEntries?: readonly WorkbenchHostDockEntry[];
  externalStateSource?: WorkbenchHostExternalStateSource;
  onLaunchRequest?: (
    request: WorkbenchHostLaunchRequest
  ) =>
    | Promise<WorkbenchHostLaunchResult | null | void>
    | WorkbenchHostLaunchResult
    | null
    | void;
  onNodeCloseRequest?: (
    request: WorkbenchHostNodeCloseRequest
  ) =>
    | Promise<WorkbenchHostNodeCloseDecision | void>
    | WorkbenchHostNodeCloseDecision
    | void;
  prepareHostClose?: (
    context: WorkbenchHostClosePreparationContext
  ) => Promise<boolean> | boolean;
}

export interface WorkbenchHostProps {
  // existing fields remain supported
  contributions?: readonly WorkbenchContribution[];
}
```

The model stays intentionally small. It mirrors the parts of
the existing host API that are already repeated across feature integrations.

## Configuration Resolution

`WorkbenchHost` normalizes all configuration through one internal
resolution step before runtime wiring.

Illustrative shape:

```ts
interface ResolvedWorkbenchHostConfig {
  nodes: readonly WorkbenchHostNodeDefinition[];
  dockEntries: readonly WorkbenchHostDockEntry[];
  externalStateSource?: WorkbenchHostExternalStateSource;
  onLaunchRequest?: WorkbenchHostProps["onLaunchRequest"];
  onNodeCloseRequest?: WorkbenchHostProps["onNodeCloseRequest"];
}

function resolveWorkbenchHostConfig(
  props: WorkbenchHostProps
): ResolvedWorkbenchHostConfig;
```

This resolver is the compatibility boundary.

Rules:

- old-style explicit host props remain first-class public API
- contributions are folded into the same resolved shape
- runtime code below the resolver should not need to care whether a capability
  came from explicit props or a contribution

## Merge Rules

Merge rules must be deterministic and documented because external consumers may
depend on current behavior.

### Nodes

- contribution-provided nodes are collected first in contribution order
- explicit `nodes` prop is appended last
- if multiple entries share the same `typeId`, the later one wins
- therefore an explicit top-level `nodes` entry overrides contribution-provided
  nodes with the same `typeId`

Rationale:

- additive contributions stay simple
- existing direct consumers keep override authority

### Dock Entries

- contribution-provided dock entries are collected first in contribution order
- explicit `dockEntries` prop is appended last
- if multiple entries share the same `id`, the later one wins
- therefore an explicit top-level dock entry overrides a contribution-provided
  entry with the same `id`

### External State Source

- if the explicit top-level `externalStateSource` prop is present, it keeps its
  current meaning and contribution-provided external-state sources are ignored
- otherwise contribution-provided sources are combined in contribution order
- when combining contribution sources, the first non-null, non-undefined state
  result wins for each lookup

This preserves current direct-consumer behavior while still allowing a purely
contribution-based host to avoid hand-writing a combiner.

If a host wants custom composition on top of contribution sources, it should
build and pass one explicit top-level `externalStateSource` intentionally rather
than rely on hidden fallback behavior.

### Launch Request

- if an explicit top-level `onLaunchRequest` is present, it runs first
- if it returns a non-null result, resolution stops
- if it returns `null` or `void`, contribution launch handlers run in
  contribution order until one returns a non-null result

This keeps current host launch behavior authoritative while allowing
contributions to act as fallbacks.

### Node Close Request

- if an explicit top-level `onNodeCloseRequest` is present, it runs first
- if it returns a close decision, resolution stops
- if it returns `void`, contribution close handlers run in contribution order
  until one returns a close decision

### Top-Level Single-Owner Inputs

The following remain top-level host inputs and are not part of the first
contribution contract:

- `snapshotRepository`
- `workspaceId`
- `missionControl`
- `layoutConstraints`
- top-level shell renderers such as `renderTopChrome` and `renderBottomChrome`
- wallpaper and shortcut policy

These are host-shell concerns, not feature contributions.

## Compatibility Model

The compatibility model is the main reason to introduce contributions as an
additive API.

### Existing Consumers

Existing consumers may continue using:

```ts
<WorkbenchHost
  nodes={...}
  dockEntries={...}
  externalStateSource={...}
  onLaunchRequest={...}
  onNodeCloseRequest={...}
  snapshotRepository={...}
  workspaceId={...}
/>
```

No migration is required in the first landing.

### Mixed Consumers

Hosts that want gradual adoption may mix both styles:

```ts
<WorkbenchHost
  contributions={[
    browserContribution,
    terminalContribution,
    issueManagerContribution
  ]}
  nodes={[filesNode]}
  onLaunchRequest={hostLaunchOverride}
  snapshotRepository={repository}
  workspaceId={workspaceId}
/>
```

This mixed mode is intentional and should be supported, not treated as a
temporary edge case.

### Contribution-first Consumers

New hosts may adopt a mostly contribution-based model while still providing the
required top-level shell inputs:

```ts
<WorkbenchHost
  contributions={contributions}
  snapshotRepository={repository}
  workspaceId={workspaceId}
/>
```

## Downstream Package Guidance

When a shared capability package adds contribution support, prefer a narrow
factory such as:

```ts
createTerminalWorkbenchContribution(...)
createIssueManagerWorkbenchContribution(...)
createBrowserWorkbenchContribution(...)
```

Those factories should accept host-provided adapters and policy inputs rather
than discovering globals or constructing product clients internally.

If a package cannot expose a contribution without learning host-specific
behavior, that is a sign the boundary is not yet ready to move into the
package.

## Desktop Adoption Boundaries

`apps/desktop` should adopt workbench contributions through feature-local
services, not through React components.

The desktop workspace workbench currently uses these modules:

- `services/internal/workbenchProductProfile.ts` and
  `services/internal/workbenchCapabilityRegistry.ts` define the product-neutral
  private seam that will move to `@tutti-os/workbench-host`. The profile declares
  a product ID, scope kind, and bound capability descriptors; the registry owns
  `order` then `id` resolution and rejects duplicate factory, contribution, node
  type, and dock entry ownership before host input is published.
- `services/internal/tuttiWorkbenchProductProfile.ts` owns the Tutti capability
  selection. It binds each desktop contribution factory to a newly projected,
  capability-specific context so factories do not receive the full product
  context or discover services through a locator.
- `services/internal/workspaceWorkbenchContributionFactory.ts` defines the
  desktop-local adapter input and generic binding helper. Concrete factories
  declare only the subset of host adapters, i18n runtimes, renderer callbacks,
  and workspace context their capability uses, then return the existing
  `WorkbenchContribution` contract.
- `services/internal/workbenchHostPorts.ts` defines the private snapshot and
  lifecycle-diagnostics ports. Desktop implementations remain under
  `services/internal/adapters`; Tutti transport and diagnostic payload mapping
  do not move into the neutral kernel.
- `services/internal/contributions/*` owns concrete desktop-local adapters for
  browser, terminal, issue-manager, files, and other workspace capabilities
  that have not yet moved into a shared package factory.
- `workspaceWorkbenchHostService.ts` owns host input assembly. It may compose
  contribution factories, snapshot repositories, close policy, wallpaper
  persistence, and desktop IPC adapters, but it should not become a feature
  business core.
- `services/workspaceWorkbenchShellRuntimeController.ts` owns shell-level
  runtime state that is independent of DOM rendering: mission control, close
  guard dialog state, host close requests, wallpaper selection, and the
  resolved host input.
- UI hooks such as `useWorkspaceWorkbenchShellRuntime.tsx` and
  `useWorkspaceChromeState.ts` are React adapters. They may subscribe to
  controllers and pass browser events or DI services into them, but they should
  not own feature orchestration.

This split keeps the module interfaces deep:

- contribution factories hide feature-specific workbench wiring behind a small
  `createContribution(...)` call
- the registry hides ordering and availability policy
- the host service hides desktop adapter construction
- shell controllers hide state transitions and side effects that do not need
  React
- React files stay shallow and mostly render snapshots, wire DOM events, and
  connect browser lifecycle to controllers

When adding a new desktop workbench capability, prefer this path:

1. add a contribution factory under the owning feature or
   `workspace-workbench/services/internal/contributions`
2. declare its narrow context and bind it in `tuttiWorkbenchProductProfile.ts`
3. let the neutral capability registry resolve and validate the profile
4. keep daemon clients, preload calls, and product enablement in desktop-owned
   adapters
5. expose only render callbacks or browser event subscriptions through the UI
   adapter when React is actually required

Do not add new workbench capability wiring directly to `WorkspaceWorkbench.tsx`,
`WorkspaceChrome.tsx`, or settings panels unless the behavior is purely
presentational. If the code decides what to launch, close, persist, refresh, or
subscribe to, it belongs in a feature-local service or controller first.

## Relationship To Existing Workbench Documents

This contribution model complements the current workbench architecture:

- [Workbench Dock Model](./workbench-dock-model.md) still defines dock identity,
  grouping, and launch semantics
- [Workbench Node Lifecycle](./workbench-node-lifecycle.md) still defines node
  definition, projected presence, launch, activation, and snapshot purity

Contributions are only a host configuration mechanism. They do not change the
underlying node lifecycle or snapshot rules.

## Current Contract Summary

The workbench contribution model is a backward-compatible optional composition
layer. It improves module ownership without forcing simple or downstream hosts
to rewrite explicit `WorkbenchHost` integrations.
