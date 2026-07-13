# Workbench Host Kernel: Phase 0 To Stable

- Date: 2026-07-11
- Status: Active; ADR accepted, PRs 1–2 merged, and PRs 3–6 approved
- Architecture decision:
  [ADR 0009](../adr/0009-cross-product-workbench-host-kernel.md)
- Scope: Tutti-first implementation, npm beta, read-only/downstream TSH
  validation, then stable release

## Outcome

Deliver a released, product-neutral `@tutti-os/workbench-host` package that lets
Tutti local workspaces and TSH collaborative rooms use the same class-based host
coordinator/session kernel while preserving all current Workbench and daemon
contracts.

The implementation is complete only after:

1. Tutti runs the shared kernel through its renderer DI composition;
2. the fixed release group publishes a beta containing the package;
3. TSH replaces hook-owned host lifecycle with an
   `@tutti-os/infra/di`-registered class service/coordinator and product adapters
   against that beta, then passes the shared conformance suite in a separate TSH
   change;
4. external findings are resolved in Tutti without product-specific leakage;
5. the package is published through the stable fixed release group; and
6. durable current-architecture/convention docs replace this active plan.

This document authorizes the fixed-group beta after PRs 3–5 merge and their
required validation passes. Stable publication remains a separate approval
gate after external TSH validation.

## Approval state

Approval recorded on 2026-07-11 remains deliberately incremental:

| Scope                                       | Approval                                 |
| ------------------------------------------- | ---------------------------------------- |
| ADR 0009 architecture boundary              | Accepted                                 |
| PR 1 characterization fixtures/tests        | Merged in #1043                          |
| PR 2 private coordinator/session            | Merged in #1044                          |
| PR 3 Product Profile/Ports/adapters split   | Approved for implementation              |
| Public package extraction and Tutti cutover | Approved after PR 3                      |
| npm beta publication                        | Approved after PRs 3–5 and validation    |
| TSH renderer DI/host migration              | Deferred; no TSH changes in current work |
| Stable publication                          | Not approved                             |

The approvals remain sequenced as independently mergeable and revertible PRs.
They do not authorize combining PRs 3–5, modifying TSH, or publishing stable.

### PR 2 implementation evidence

The approved Tutti-private proof keeps the extraction boundary reviewable:

- `workbenchHostCoordinator.ts` owns renderer-local scope indexing, same-
  partition lease reuse, immutable-partition replacement, and coordinator-wide
  disposal;
- `workbenchHostSession.ts` owns the immutable partition snapshot, stable host-
  input publication, surface attachment, subscriptions, resource cleanup, and
  idempotent disposal;
- Tutti registers one coordinator in its existing `@tutti-os/infra/di`
  renderer root and injects it into the existing product host service;
- `WorkspaceWorkbenchHostService` remains the Tutti facade and product adapter:
  it supplies the workspace partition and retains all existing contribution,
  preload, tuttid, wallpaper, onboarding, dock, diagnostics, and business-
  service wiring;
- a committed React effect acquires an opaque binding to one exact lease before
  rendering the session-backed shell; host-input projection never acquires a
  lease, and stale bindings cannot attach to or release a replacement session;
  and
- focused unit tests cover DI singleton ownership, lease reuse, multi-scope
  isolation, principal-partition replacement, referential publication,
  per-binding attachment/subscription cleanup, failed initial resolution
  ownership, branded-configuration mismatch, sync/async exception-safe
  teardown, and idempotent disposal.

This proof does not introduce Product Profile or Ports, move product adapters,
create a package, change public Workbench contracts, or authorize any release or
TSH change.

### PR 3 implementation evidence

The approved product-boundary split keeps all new seams Tutti-private until the
package API review:

- `workbenchProductProfile.ts` declares only product ID, scope kind, and bound
  capability descriptors;
- `workbenchCapabilityRegistry.ts` owns deterministic `order` then `id`
  resolution and rejects duplicate factory, contribution, node type, and dock
  entry ownership before publication;
- `tuttiWorkbenchProductProfile.ts` owns Tutti capability selection and projects
  a separate narrow context for each capability adapter rather than passing the
  complete product context;
- `workbenchHostPorts.ts` defines product-neutral snapshot and lifecycle
  diagnostics ports, while desktop repository and diagnostics implementations
  remain product adapters;
- the coordinator/session classes use the diagnostics port without importing
  Tutti runtime APIs, and the existing Tutti host facade still owns all product
  composition; and
- focused tests preserve contribution IDs/order, node and dock contracts,
  repository metadata behavior, diagnostic mapping, session lifecycle, and
  duplicate ownership rejection.

PR 3 does not create a package, change public Workbench or daemon contracts,
modify TSH, or publish the approved beta. Those remain the independent PR 4–6
steps.

## Baseline evidence

### Tutti

- `@tutti-os/workbench-surface` already owns the disposable shell session,
  snapshot sanitation, projected-node reconciliation, activation, and shell
  persistence scheduling.
- The desktop uses `@tutti-os/infra/di` and a renderer-scoped
  `WorkspaceWorkbenchHostService` class.
- The product host class currently mixes reusable host-input coordination with
  Tutti adapters, wallpaper/onboarding metadata, preload APIs, daemon clients,
  dock product policy, and other product services.
- Tutti's canonical snapshot API remains
  `GET/PUT /v1/workspaces/{workspaceID}/workbench`.

### TSH (read-only evidence, 2026-07-11)

- TSH has deterministic contribution factories ordered by `order` then `id`
  and rejects duplicate factory, contribution, node type, and dock entry IDs.
- TSH's host service is a React hook that owns repository adaptation,
  contribution caching, projection refs, dock runtime, and restored-focus state.
- TSH already depends on `@tutti-os/infra` and uses its DI implementation in the
  Electron main process, but its renderer has not yet established the target
  Workbench class-service registration and renderer composition root.
- TSH desktopd durably stores snapshots under `(room_id, user_id)`, derives the
  user ID from authenticated desktop state, and uses the shared Go Workbench
  service for canonical validation.
- TSH's renderer repository additionally partitions its optimistic/cache state
  by room and authenticated user.
- TSH keeps terminal and agent reconciliation in an explicit desktopd runtime
  reconciler and keeps cloud/shared-agent uncertainty out of destructive
  reconciliation.

These are compatible foundations. The gap is the renderer host lifecycle, not
the snapshot schema or business authority model.

## Frozen compatibility envelope

All PRs in this plan must preserve:

- the public `WorkbenchContribution` shape and merge precedence;
- the current snapshot schema, migration behavior, and
  `snapshotNodeState`/`externalNodeState` distinction;
- projected and launched node IDs, `typeId`, `instanceId`, `instanceKey`, and
  `dockEntryId` semantics;
- current product dock order and duplicate override behavior;
- Tutti and TSH daemon HTTP request/response shapes;
- Tutti workspace and TSH room identifiers at existing public call sites;
- daemon-owned snapshot durability and reconciliation;
- product-owned terminal, agent, chat, app, file, transfer, and collaboration
  authority; and
- existing user-visible behavior, close guards, mission control, launchpad,
  wallpaper, and shortcuts.

Changing any item above requires a separately reviewed contract proposal and is
not a hidden prerequisite for this plan.

## Target API sketch

Names may be refined during the package API review, but responsibility and
lifetime may not move across these boundaries.

```ts
interface WorkbenchScope {
  kind: "workspace" | "room";
  id: string;
}

interface WorkbenchAuthenticatedPrincipalSnapshot {
  id: string;
}

interface WorkbenchSnapshotPartition {
  scope: WorkbenchScope;
  principal?: WorkbenchAuthenticatedPrincipalSnapshot;
}

interface WorkbenchProductProfile {
  productId: string;
  scopeKind: WorkbenchScope["kind"];
  capabilityFactories: readonly WorkbenchCapabilityFactoryDescriptor[];
}

interface WorkbenchHostCoordinator {
  open(input: WorkbenchHostSessionOpenInput): WorkbenchHostSessionLease;
  get(partition: WorkbenchSnapshotPartition): WorkbenchHostSession | null;
  dispose(): void;
}

interface WorkbenchHostSession {
  readonly partition: WorkbenchSnapshotPartition;
  getHostInput(): StableWorkbenchHostInput;
  update(update: WorkbenchHostSessionUpdate): void;
  attachSurface(handle: WorkbenchHostHandle | null): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
```

The real API should prefer opaque canonical partition keys over exposing string
concatenation. It must not expose product clients, React hooks, or a generic
service locator.

## DI and package dependency target

The shared package is DI-neutral: coordinator/session constructors accept
ordinary interfaces and do not import `@tutti-os/infra/di`. The two official
renderer products still converge on the same integration framework:

- Tutti keeps `@tutti-os/infra/di` as its renderer service container;
- TSH adds an `@tutti-os/infra/di` renderer composition root and registers its
  Workbench class service/coordinator there; and
- each product owns its decorator/token, registration function, constructor
  adapters, and window/renderer lifetime wiring.

This is intentional convergence at the official renderer layer, not DI coupling
inside `@tutti-os/workbench-host`.

The package dependency direction is also fixed:

```text
product renderer -> @tutti-os/workbench-host
product renderer -> @tutti-os/workbench-surface
@tutti-os/workbench-host -- type-only/public-contract --> @tutti-os/workbench-surface
@tutti-os/workbench-surface -X-> @tutti-os/workbench-host
```

Host may import surface public contracts such as `WorkbenchContribution` and
`WorkbenchHostHandle` with `import type`, and its emitted declarations may refer
to React types carried by those contracts. Host runtime code must not import
React, call hooks, mount components, own effect lifecycle, or require surface to
import host. Package extraction stops for architecture review if its emitted
JavaScript gains a React runtime dependency or if the package graph contains a
host/surface cycle.

## State owner and restart matrix

| State                                   | Runtime writer                                            | Durable/restart owner                   | Session behavior                                                  |
| --------------------------------------- | --------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Workbench shell layout and stack        | Workbench surface controller                              | Tutti `tuttid`; TSH desktopd SQLite     | Load/save through repository port                                 |
| Snapshot normalization/schema           | Shared snapshot package and Go service                    | Canonical schema sources                | Never reinterpret                                                 |
| Contribution set and order              | Profile plus capability factories                         | Source code/package version             | Resolve once per stable configuration; update explicitly          |
| Dynamic dock presentation               | Capability store/service                                  | Usually recomputed                      | Subscribe without session rebuild                                 |
| Projected shell presence                | Product runtime/business service                          | Owning daemon/control plane             | Reconcile live; never recreate business entity from snapshot      |
| Surface handle and activation sequence  | Surface session                                           | None                                    | Attach/detach; discard on session disposal                        |
| Repository optimistic cache/save queue  | Product repository adapter or session port implementation | Daemon remains authority                | Partitioned; rollback/ignore stale completion on failure/disposal |
| Authenticated identity partition        | Product auth authority                                    | Product auth/profile state              | Immutable snapshot for one session; replace session on change     |
| Wallpaper/onboarding snapshot metadata  | Tutti adapter during Phase 0                              | Existing Tutti snapshot repository path | Preserve byte/semantic compatibility                              |
| Room collaboration, shared agents, chat | TSH control plane/domain adapters                         | TSH authorities                         | Capability projection only                                        |

## Required invariants and conformance assertions

At minimum, implementation tests must prove:

1. the coordinator returns no more than one live session for the same canonical
   partition and disposes every owned session exactly once;
2. changing a TSH authenticated-user snapshot changes the canonical partition,
   never reuses room cache, and invalidates stale async completion from the old
   session;
3. contribution order is `order`, then `id`, with duplicate contribution IDs,
   node type IDs, and dock entry IDs rejected before host input is published;
4. dynamic projection/dock changes preserve session, contribution identity,
   node identity, and surface handle;
5. snapshot load/restore cannot invoke capability launch/create commands;
6. disposed sessions cannot notify, persist, attach a handle, or accept updates;
7. product adapters are the only imports of product transport/auth APIs; and
8. the host kernel produces the same node definitions, dock order, close
   preparation, and launch routing as the pre-migration Tutti host fixtures.
9. both official renderers resolve their product-owned Workbench class service
   through `@tutti-os/infra/di`, while the shared host package has no DI runtime
   dependency.
10. the built host package has no React runtime import, surface has no host
    dependency, and the package graph is acyclic.

## Shared conformance suite

The package will provide a consumer-facing test harness, preferably through an
explicit `@tutti-os/workbench-host/conformance` development subpath. It may be
excluded from application runtime bundles, but its contract is public enough
for TSH to run the same assertions.

The harness accepts:

- a coordinator factory;
- a product profile fixture;
- in-memory snapshot, diagnostics, and surface ports;
- a partition factory;
- capability fixtures with recorded create/update/dispose calls; and
- product-specific expected contribution IDs and dock order.

Shared cases cover:

- open/get/lease/release/dispose lifecycle;
- concurrent distinct partitions;
- same scope/different principal isolation;
- deterministic factory order and duplicate rejection;
- stable host input across dynamic updates;
- projection updates without launch side effects;
- load/save failure and stale completion behavior;
- attach/detach of a surface handle;
- no callbacks after disposal;
- snapshot purity using canonical snapshot fixtures; and
- compatibility of explicit host props and contributions where the kernel
  delegates to the existing surface resolver.

Each product adds adapter cases:

- Tutti: workspace ID mapping, existing daemon repository adapter,
  wallpaper/onboarding metadata preservation, current dock order, current node
  IDs, and DI singleton/session disposal.
- TSH: room ID mapping, authenticated-user partition, desktopd request bodies
  without user ID, room/user cache isolation, TSH-only contribution order, and
  room/shared-agent business authority.

Passing only package unit tests is insufficient for beta or stable promotion.

## Existing-to-target module migration map

Target paths below are part of this plan so ownership does not get decided ad
hoc during extraction. Minor filename refinements are allowed only when the same
owner, dependency direction, and PR boundary remain explicit.

### Tutti mapping

| Existing file/module                                                                                                           | Target module and owner                                                                                                                                                                                                                                                                                                                                                                                                                  | PR     | Migration disposition                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceWorkbenchHostService.ts`                | Reusable lifecycle moves first to Tutti-private `apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workbenchHostCoordinator.ts` and `workbenchHostSession.ts` (PR 2), then to `packages/workbench/host/src/coordinator/workbenchHostCoordinator.ts` and `packages/workbench/host/src/session/workbenchHostSession.ts` (PR 4). The existing desktop service becomes a thin Tutti class facade/product adapter. | 2–5    | Move session indexing, replacement, stable host-input publication, leases, and disposal to the kernel. Keep Tutti preload/tuttid adapters, wallpaper/onboarding compatibility, desktop copy, window-close policy, diagnostics wiring, and feature service dependencies product-owned; split unrelated product services rather than exporting them from host. |
| `apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceWorkbenchContributionRegistry.ts`       | `packages/workbench/host/src/capabilities/workbenchCapabilityRegistry.ts`; Tutti's ordered factory descriptors move to `apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/tuttiWorkbenchProductProfile.ts`.                                                                                                                                                                                                   | 1, 3–4 | Characterize current order first. Move generic order/duplicate validation to host; retain Tutti factory selection, enablement, and product dependencies in the Product Profile/adapters. Do not change `WorkbenchContribution` merge behavior.                                                                                                               |
| `apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/adapters/desktopWorkspaceWorkbenchRepository.ts` | Remains a Tutti product adapter implementing `WorkbenchSnapshotRepositoryPort`; optional interface types live in `packages/workbench/host/src/ports/workbenchSnapshotRepositoryPort.ts`.                                                                                                                                                                                                                                                 | 1, 3–5 | Do not move tuttid client calls or wallpaper/onboarding metadata preservation into host. Adapt existing `workspaceId` cache/load/save/subscribe behavior to the port unchanged.                                                                                                                                                                              |
| `apps/desktop/src/renderer/src/features/workspace-workbench/services/registerWorkspaceWorkbenchServices.ts`                    | Remains the Tutti-owned `@tutti-os/infra/di` registration entry; registers the product service/coordinator and supplies Tutti profile/ports.                                                                                                                                                                                                                                                                                             | 2, 5   | Keep decorator/token and `SyncDescriptor` wiring in desktop. The shared package exports classes/contracts, not a Tutti registration helper or global locator.                                                                                                                                                                                                |
| `apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx`                                         | Remains a Tutti React presentation adapter consuming the DI service/session and rendering `WorkbenchHost`.                                                                                                                                                                                                                                                                                                                               | 2, 5   | Remove host construction/business coordination from React. Keep DOM, chrome, overlays, handle attachment, subscriptions, and rendering. It may refer to surface runtime contracts but does not become a kernel module.                                                                                                                                       |
| `apps/desktop/src/renderer/src/features/workspace-workbench/ui/useWorkspaceWorkbenchShellRuntime.tsx`                          | Remains a focused Tutti React adapter for leasing/subscribing to the DI-owned session; product shell controllers stay under desktop services.                                                                                                                                                                                                                                                                                            | 2, 5   | Replace hook-owned orchestration with calls to the class service. Effect cleanup releases/detaches the session but the host package owns no React effect lifecycle. Preserve mission control, close guards, wallpaper, shortcuts, and host-input identity.                                                                                                   |

### TSH mapping

All TSH changes below belong to a separately approved TSH PR after npm beta;
this Tutti task does not modify those files.

| Existing file/module                                                                                                                                                                                                                                        | Target module and owner                                                                                                                                                                                                                                                                                                              | PR  | Migration disposition                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/internal/workspaceWorkbenchHostService.ts` (current hook) and public `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/useWorkspaceWorkbenchHostService.ts` | Convert the internal module at the same path to a product-owned class service/facade around `WorkbenchHostCoordinator`; export its DI token from `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/workspaceWorkbenchHostService.interface.ts`. Keep the public hook only as `useService(token)` convenience. | 7   | Move lifecycle, partition indexing, contribution resolution, session update/disposal, and stable host input to the shared class kernel. Keep TSH room policy, restored-focus projection, dock business adapters, diagnostics, and capability-specific dependencies in TSH adapters. |
| `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/internal/workspaceWorkbenchContributionRegistry.ts`                                                                                                                                | Generic behavior is consumed from `@tutti-os/workbench-host`; TSH descriptors move to `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/internal/tshWorkbenchProductProfile.ts`.                                                                                                                              | 7   | Preserve `order` then `id` and all current duplicate ownership checks. Retain TSH capability availability, room chat/shared-agent inputs, and factory cache keys in capability adapters/profile rather than a product-union context.                                                |
| `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/internal/adapters/desktopWorkspaceWorkbenchRepository.ts`                                                                                                                          | Remains the TSH `WorkbenchSnapshotRepositoryPort` adapter.                                                                                                                                                                                                                                                                           | 7   | Preserve `(roomId, authenticatedUserId)` renderer cache partition, optimistic queue/rollback behavior, initialized marker policy, and existing desktopd GET/PUT bodies. User ID is never added to the request body.                                                                 |
| `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/ui/WorkspaceWorkbenchHostShell.tsx`                                                                                                                                                         | Remains the TSH React presentation adapter; obtains its class service/session from renderer DI and renders `WorkbenchHost`.                                                                                                                                                                                                          | 7   | Remove hook-owned host construction. Keep DOM/chrome/overlay/dialog providers, surface handle attachment, and TSH presentation wiring. Dynamic status changes update a stable session rather than remounting it.                                                                    |
| No Workbench renderer DI registration exists today                                                                                                                                                                                                          | Add product-owned `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/registerWorkspaceWorkbenchServices.ts`, plus renderer composition root `apps/tsh-desktop/src/app/renderer/bootstrap/createRendererServiceContainer.ts`; provide the container through the renderer app shell.                             | 7   | Use `@tutti-os/infra/di` `ServiceRegistry`, `InstantiationService`, product token, and descriptor wiring, mirroring Tutti's class-service pattern without moving registration into the shared package. Container disposal must dispose the coordinator and all room sessions.       |
| `apps/tsh-desktop/src/app/renderer/bootstrap/renderApp.tsx` and the `TSHDesktopApp` composition path                                                                                                                                                        | Compose/provide the TSH renderer DI container and register Workbench product adapters before workspace UI renders.                                                                                                                                                                                                                   | 7   | Keep app/bootstrap as composition only. It must not absorb room business rules or construct capability contributions itself.                                                                                                                                                        |

## Delivery sequence

Every PR below is independently mergeable and revertible. A PR may introduce a
dormant seam or dual-run assertion, but it may not leave two active writers or
two launch/close authorities.

| PR  | Repository              | Change                                                                                                                                              | Acceptance                                                                                                                                                                                                                             | Minimum verification                                                                                                                                                                                                        | Rollback boundary                                                                                          |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 0   | Tutti                   | Land ADR, this spec, and indexes only                                                                                                               | Docs describe owners, invariants, release gates, risks, and open questions; no runtime files change                                                                                                                                    | Markdown format/link check and diff scope audit                                                                                                                                                                             | Revert docs only                                                                                           |
| 1   | Tutti                   | Add characterization fixtures/tests around current host composition and lifecycle                                                                   | Current contribution IDs, node IDs, dock order, host-input stability, snapshot metadata, close behavior, and daemon calls are pinned without production behavior change                                                                | Workbench host/registry/repository focused tests; `pnpm --filter @tutti-os/workbench-surface test`; `pnpm check:renderer-boundaries`                                                                                        | Remove tests/fixtures                                                                                      |
| 2   | Tutti                   | Introduce Tutti-private coordinator/session interfaces and product-neutral classes behind the current DI service                                    | One renderer coordinator creates/disposes per-workspace sessions; existing public service and UI behavior stay unchanged; no product-union context; file migration follows the mapping above                                           | New class unit tests, focused desktop host tests, `pnpm --filter @tutti-os/desktop typecheck`, `pnpm check:renderer-boundaries`                                                                                             | Switch DI registration back to existing service                                                            |
| 3   | Tutti                   | Move Tutti-only policy into Product Profile, capability adapters, and narrow ports                                                                  | Kernel classes contain no Tutti client, preload, Electron, wallpaper, onboarding, agent, terminal, or app-center imports; existing adapter tests pass                                                                                  | Import-boundary test, characterization suite, desktop typecheck/tests, `pnpm check:electron-runtime-boundaries` where imports move                                                                                          | Restore adapter calls behind unchanged service facade                                                      |
| 4   | Tutti                   | Extract `packages/workbench/host` as `@tutti-os/workbench-host`; add conformance harness and package docs                                           | Public exports are limited; surface use is type-only/public-contract; emitted JS has no React runtime import; surface does not import host; package graph is acyclic; pack and fixed release roster/config/scripts include the package | Package test/typecheck/build, emitted-import and dependency-cycle checks, conformance tests, `pnpm release:pack:check`, `pnpm lint:ts`, `pnpm typecheck`, `pnpm check:ui-boundaries` if package graph touches UI boundaries | Stop extraction on React runtime/cycle; otherwise revert package extraction and keep private proven kernel |
| 5   | Tutti                   | Cut Tutti adapter fully to the package and remove private duplicate kernel                                                                          | Exactly one host coordination path; one DI coordinator per renderer/window; sessions dispose on scope/container teardown; all frozen compatibility fixtures match                                                                      | Focused host + workspace shell tests, `pnpm check:changed`, desktop build, Workbench surface tests                                                                                                                          | Revert adapter cutover to private kernel package-equivalent commit                                         |
| 6   | Tutti release operation | Publish fixed-group npm beta after explicit approval                                                                                                | `@tutti-os/workbench-host@beta` and its exact fixed-group peers are installable; no `latest`, git tags, lockfile edits, or commits are produced                                                                                        | `pnpm release:pack:check`; dry inspection of versions/tarballs; `pnpm release:beta`; verify npm dist-tags and clean worktree                                                                                                | Deprecate bad beta; publish a new beta version, never overwrite                                            |
| 7   | TSH                     | In a separate TSH PR, upgrade released beta dependencies, add renderer `@tutti-os/infra/di` registration, and adapt the host to coordinator/session | No filesystem links; room/user partition preserved; DI-resolved class service owns lifecycle; hook no longer owns host lifecycle; existing daemon API and business authority unchanged                                                 | Shared conformance suite, renderer DI/container disposal tests, focused TSH Workbench Vitest tests, `pnpm --dir apps/tsh-desktop check`, desktopd focused Go tests if adapters touch repository wiring                      | Revert dependency/DI/adapter PR to last released stable packages                                           |
| 8   | Tutti                   | Resolve beta findings generically; publish further beta(s) only when approved                                                                       | Fixes are expressed as kernel contract/conformance changes, not `if (productId === ...)`; Tutti and TSH conformance both pass                                                                                                          | Package/Tutti full focused suite; TSH reports exact beta and passing suite                                                                                                                                                  | Revert individual generic fix or use next beta                                                             |
| 9   | Tutti                   | Promote docs and prepare stable release                                                                                                             | Current Workbench architecture/conventions describe implemented kernel; active spec is removed when rollout is complete; release roster and package entrypoints are durable                                                            | Docs checks, `pnpm check:full`, package pack check, downstream evidence recorded                                                                                                                                            | Revert docs/release-prep PR; stable not yet published                                                      |
| 10  | Tutti release operation | Publish stable fixed release group after explicit approval                                                                                          | `latest` contains the validated package set; `packages-v<version>` and all existing `packages/**/go.mod` tags are present; TSH can replace beta with exact stable versions                                                             | Stable workflow logs, npm dist-tags, package tarball smoke test, git tag audit, clean main checkout                                                                                                                         | Follow forward with a new fixed-group release; never retag or overwrite                                    |

PR numbers describe dependency order, not a requirement that every concern be a
large diff. If a PR cannot be reverted without reverting a later PR, the later
PR must not merge first.

## Phase gates

### Phase 0: Tutti-first proof

Includes PRs 0–3. Exit criteria:

- frozen behavior is characterized;
- reusable lifecycle code is a class with no React ownership;
- one coordinator owns disposable workspace sessions;
- profiles/ports/adapters have no product union or inheritance;
- the planned host-to-surface dependency is type-only/public-contract and has no
  reverse edge; and
- no public package or release change is required to revert the proof.

### Package beta

Includes PRs 4–6. Exit criteria:

- public API review approves every root/subpath export;
- emitted host JavaScript has no React runtime import and dependency-cycle
  checks prove surface does not depend on host;
- pack output and fixed release group are correct;
- the beta does not change stable tags or Go module versions;
- Tutti uses the exact code published in the beta.

### TSH external validation

Includes PRs 7–8. TSH remains read-only from this Tutti planning task; its
implementation requires separate approval and repository workflow.

Exit criteria:

- TSH consumes npm beta from the registry, not a local path;
- TSH resolves the Workbench class service/coordinator through a product-owned
  `@tutti-os/infra/di` renderer registration;
- room ID and immutable authenticated-user partition tests pass;
- TSH-only capabilities stay in TSH adapters;
- shared conformance results and exact beta versions are attached to the Tutti
  stable approval; and
- no new shared API exists solely to expose TSH control-plane concepts.

### Stable

Includes PRs 9–10. Exit criteria:

- both product adapters pass shared and product conformance suites;
- no unresolved P0/P1 lifecycle, data isolation, snapshot, or business-authority
  defect remains;
- current architecture/convention docs own the implemented truth;
- release automation and durable package roster agree;
- stable publication is separately approved.

## Release and versioning details

- Add `@tutti-os/workbench-host` to the one fixed npm release group; do not add
  an independent version, Changeset-only path, or host-only workflow.
- Audit the roster in `docs/conventions/npm-package-release.md`,
  `.changeset/config.json`, root package scripts, package-version application,
  pack checking, beta publishing, and stable publishing. Reconcile existing
  drift before adding the new name.
- Beta is npm-only, uses the `beta` dist-tag, and must restore temporary manifest
  edits. TSH records the exact prerelease version in its lockfile-generated
  dependency update.
- Stable uses the next repository-approved fixed-group version and
  `packages-v<version>`.
- Stable also emits submodule tags for every existing `packages/**/go.mod`.
  `packages/workbench/service/v<version>` continues even when its code did not
  change because it participates in the shared stable tag sequence.
- Do not add `packages/workbench/host/go.mod`. If a later Go host contract is
  justified, it needs its own design and package ownership review.

## Verification strategy

### Documentation-only PR 0

Run the lowest documentation checks available in the repository:

```sh
pnpm exec prettier --check \
  docs/adr/0009-cross-product-workbench-host-kernel.md \
  docs/adr/README.md \
  docs/specs/2026-07-11-workbench-host-kernel-phase-0-to-stable.md \
  docs/specs/README.md
git diff --check
git diff --name-only
git diff --stat
```

Also confirm no TSH file changed:

```sh
git -C /Users/ryan/dev/tutti-lab/tsh status --short
```

### Implementation PRs

Use the minimum checks in the PR table first. Before the Tutti cutover or stable
release, also run:

```sh
pnpm check:changed
pnpm --filter @tutti-os/workbench-surface test
pnpm --filter @tutti-os/workbench-surface typecheck
pnpm --filter @tutti-os/desktop build
pnpm release:pack:check
```

Run `pnpm check:full` for the final stable preparation. Daemon Go tests and API
generation checks are required only if a separately approved change touches Go
or OpenAPI; this plan expects no such contract change.

### TSH external validation report

The TSH PR must report:

- exact npm beta versions and lockfile diff;
- shared conformance cases and results;
- product adapter tests for `(roomId, authenticatedUserId)` isolation;
- focused renderer Workbench test results;
- whether desktopd code changed (expected: no API/schema change); and
- confirmation that no Tutti filesystem link or copied kernel source exists.

## Risks and mitigations

| Risk                                                             | Effect                                                            | Mitigation / stop condition                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Public kernel becomes a renamed Tutti host                       | TSH cannot consume it without fake adapters                       | Import-boundary tests; reject Tutti product types in package exports                              |
| Product-union context grows                                      | Every capability sees unrelated optional services                 | Narrow capability ports; API review rejects optional product bags                                 |
| Session replacement during dynamic status update                 | Open nodes disappear or async actions target stale handle         | Stable update channel and identity assertions; dynamic dock conformance case                      |
| Auth change reuses a TSH room cache                              | Cross-user layout disclosure or overwrite                         | Immutable principal partition; replacement/disposal tests; desktopd remains enforcement authority |
| Disposed async save wins later                                   | Old scope overwrites current cache or snapshot                    | Generation/abort guard and queued-write conformance tests                                         |
| Contribution ordering changes                                    | Dock or launch behavior regresses                                 | Characterization fixtures before extraction; exact expected order per product                     |
| Snapshot restore creates business entities                       | Duplicate terminals/agents or authority inversion                 | Restore-with-zero-launch assertion and existing projection rules                                  |
| Surface and host sessions duplicate responsibilities             | Conflicting state owners and teardown                             | Keep surface mechanics in surface; kernel coordinates only product-host lifecycle                 |
| Host extraction imports React runtime or creates a package cycle | Headless ownership is false and package layering becomes unstable | Stop extraction; retain the private proof and re-review the boundary before beta                  |
| TSH keeps hook lifecycle beside the DI class service             | Two host owners and incomplete product convergence                | PR 7 removes hook ownership; renderer DI/container disposal is a conformance requirement          |
| Fixed release roster is already inconsistent                     | Wrong package set published                                       | Mandatory roster audit in extraction PR; fail closed on mismatch                                  |
| Beta works only through local workspace resolution               | TSH fails after install                                           | Tarball consumer smoke test and registry-based TSH validation                                     |
| Cross-repo rollout leaves a long-lived dual path                 | Behavior drift continues                                          | One active writer/launcher invariant; each cutover removes its replaced path                      |

## Non-goals

- changing Workbench visuals, interaction mechanics, mission control, or
  launchpad design;
- changing the snapshot schema, node identity, dock semantics, or contribution
  contract;
- moving daemon persistence or reconciliation into TypeScript;
- syncing TSH layout through the control plane or across devices;
- making Tutti and TSH expose the same product capabilities;
- sharing product authentication, terminal, agent, chat, app, file, transfer,
  or collaboration services;
- binding `@tutti-os/workbench-host` itself to a DI framework or exporting
  product registration from the shared package; both official renderers still
  intentionally use `@tutti-os/infra/di` through product-owned registration;
- creating a plugin marketplace or runtime extension loader;
- publishing beta/stable as part of implementation PRs; or
- modifying TSH from this Tutti task.

## Open questions requiring an approval or measured evidence

1. **Surface attachment:** keep current `WorkbenchHost` props plus
   `onHandleReady`, or add an external surface-session input later?
   Recommendation: preserve current props for Phase 0; measure whether the
   attachment seam causes duplicate lifecycle.
2. **Coordinator multiplicity:** officially support concurrent Workbench
   sessions in one renderer, or keep it an internal capability?
   Recommendation: test it, but do not promise multi-view UX in the first API.
3. **Tutti user partition:** is `workspaceId` sufficient under the current local
   desktop authority for stable, or must account switching be part of the first
   package contract? Recommendation: keep existing Tutti mapping; require a
   follow-up ADR before multi-user local durability.
4. **Product metadata:** should wallpaper/onboarding metadata remain in Tutti's
   repository adapter or move to a dedicated metadata contribution?
   Recommendation: preserve current adapter behavior through beta.
5. **Conformance subpath:** public `./conformance` versus repository-only shared
   test package? Recommendation: public dev/test subpath so the external TSH
   repository runs the exact suite shipped with the beta.

## Approval gates

ADR 0009 is accepted; PR 1 merged as #1043 and PR 2 merged as #1044. PRs 3–5
and the fixed-group beta in PR 6 are approved in sequence. TSH integration is
deferred until later business adoption and remains outside the current Tutti
implementation scope. Stable publication remains separately unapproved.
