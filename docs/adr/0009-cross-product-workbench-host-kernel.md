# ADR 0009 — Share a class-based Workbench host kernel across Tutti and TSH

- Date: 2026-07-11
- Status: Accepted
- Decision owners: Tutti desktop and Workbench maintainers
- Related:
  - [Workbench](../conventions/workbench.md)
  - [Workbench Contributions](../architecture/workbench-contributions.md)
  - [Workbench Node Lifecycle](../architecture/workbench-node-lifecycle.md)
  - [Workbench Dock Model](../architecture/workbench-dock-model.md)
  - [Phase 0 to stable implementation plan](../specs/2026-07-11-workbench-host-kernel-phase-0-to-stable.md)

## Context

Tutti and TSH already share the canonical Workbench snapshot contract, Go
validation service, surface mechanics, contribution contract, node identity
helpers, and dock model. Their product hosts still own similar coordination in
different forms:

- Tutti has a renderer DI singleton class that assembles and caches
  workspace-specific host input, but the class also contains Tutti product
  services and policies.
- TSH has a contribution-first registry and durable room/user snapshot
  repository, but its host coordination is still implemented as React hooks.
- `@tutti-os/workbench-surface` has a disposable shell session for layout,
  projection reconciliation, activation, and snapshot saves. It intentionally
  does not own product capability assembly or product business policy.

Class-based dependency injection alone does not solve this divergence. DI can
construct and locate a long-lived service, but it does not define:

- how one renderer owns multiple sequential or concurrent Workbench scopes;
- which inputs are renderer-singleton state and which are scope-local state;
- when subscriptions, save queues, caches, and live projections are disposed;
- how product-neutral contributions are ordered and validated;
- how a user identity change prevents one user's cached snapshot from leaking
  into another user's room session;
- which changes may update a live session and which require replacement.

Without a shared lifecycle owner, a DI service tends to become either a product
mega-service or a thin wrapper around React lifecycle. Both products then have
to rediscover the same session, disposal, cache, and conformance rules.

## Decision

Tutti and TSH will share a **class-based, DI-friendly Workbench host kernel**.
The target public package is `@tutti-os/workbench-host`, subject to the
extraction gate in the implementation plan.

The kernel has two explicit lifetime levels:

1. one `WorkbenchHostCoordinator` per renderer/window DI root; and
2. one disposable `WorkbenchHostSession` per open Workbench scope partition.

The coordinator and session are ordinary classes with constructor-injected
interfaces. The package does not require a particular DI container and does not
use global service lookup. Both official renderers will use
`@tutti-os/infra/di` to register their class service/coordinator. Each product
still owns its service token, registration function, constructor adapters, and
renderer composition root; none of that registration becomes a responsibility
of the shared package. DI creates the coordinator, while the coordinator
creates, indexes, replaces, and disposes scope sessions.

This host session is the product-host coordination layer above the existing
`@tutti-os/workbench-surface` shell session. The surface remains the owner of
window mechanics and shell persistence behavior. The host kernel must compose
the surface contract rather than reimplement its reducer, contribution merge
rules, snapshot sanitizer, node identity, or dock behavior.

## Dependency direction

The allowed package direction is:

```text
Tutti renderer ─┬─> @tutti-os/workbench-host
                └─> @tutti-os/workbench-surface

TSH renderer ───┬─> @tutti-os/workbench-host
                └─> @tutti-os/workbench-surface

@tutti-os/workbench-host -- type-only/public-contract --> @tutti-os/workbench-surface
@tutti-os/workbench-surface -X-> @tutti-os/workbench-host
```

`@tutti-os/workbench-host` may use type-only or declaration-level dependencies
on public surface contracts such as `WorkbenchContribution`,
`WorkbenchHostHandle`, snapshot repository seams, and stable host-input types.
Those declarations may transitively mention React types because the existing
surface contribution contract contains render functions and React values.

This allowance does not give the host package React runtime ownership. Emitted
host JavaScript must not import React, mount components, call hooks, own effect
lifecycle, or implement `WorkbenchHost` rendering. It also must not import
surface runtime helpers in a way that creates a runtime dependency cycle.
Surface remains independently usable and must never import host.

If extraction produces a React runtime dependency, a `surface -> host` reverse
dependency, or any host/surface cycle, the extraction must stop. Maintainers
must re-review package ownership and move the disputed behavior back behind a
product adapter or a lower-level neutral contract before continuing.

## Canonical model

### Shared kernel

The shared kernel owns only product-neutral coordination:

- coordinator/session lifecycle and idempotent disposal;
- immutable scope and authenticated-principal snapshots captured at session
  creation;
- deterministic capability-factory ordering and duplicate ownership checks;
- stable contribution and host-input composition;
- subscription and resource cleanup;
- session replacement when an immutable partition changes;
- forwarding dynamic projections and presentation-state updates without
  rebuilding the session;
- diagnostics hooks for lifecycle and invariant violations;
- a product-neutral conformance harness.

The shared kernel does not own Electron, React runtime lifecycle or components,
daemon clients, authentication discovery, workspace or room business rules,
cloud projection, terminal or agent lifecycle, user-visible product copy, or
product-specific snapshot metadata. Type declarations may reference the public
surface contracts described above.

### Product Profile

A `WorkbenchProductProfile` describes stable product-level choices. It is data
and narrow callbacks, not a service bag. A profile includes:

- a stable product ID;
- supported scope kind (`workspace` for Tutti, `room` for TSH);
- deterministic capability factory descriptors;
- host-level compatibility policy that cannot be expressed by a capability;
- declared snapshot metadata ownership, if any;
- optional feature flags that are stable for the lifetime of a session.

Profiles must not contain Tutti-or-TSH union fields, transport clients, mutable
business stores, or optional properties for every product capability.

### Ports

Ports are small interfaces through which the kernel reaches an owner outside
the kernel. The initial port families are:

- `WorkbenchSnapshotRepositoryPort`: load, cached read, save, and optional
  change subscription for an opaque snapshot partition;
- `WorkbenchDiagnosticsPort`: structured lifecycle and invariant diagnostics;
- `WorkbenchCapabilityRegistryPort`: supplies the factories allowed by the
  selected profile, if they are not passed directly at composition;
- `WorkbenchSessionClockPort` only if deterministic time is proven necessary;
- surface-session attachment/update seams needed to connect the headless host
  session to `@tutti-os/workbench-surface`.

Ports expose product-neutral values. A port must not grow into a renamed
`window.tutti`, `window.tshApi`, `TuttidClient`, desktopd client, control-plane
client, or product service container.

### Capability contributions

The existing `WorkbenchContribution` remains the canonical capability output.
Feature-owned factories may contribute node definitions, dock entries, external
state, launch handling, close handling, and close preparation under the current
contract.

The kernel adds lifecycle and ownership around contribution factories; it does
not replace `WorkbenchContribution` and does not change its merge semantics.
Each factory receives:

- a minimal immutable session context (`productId`, scope, partition identity);
- only the capability-specific ports supplied by the product adapter; and
- stable presentation inputs that the capability genuinely owns.

A factory must not receive an entire product context and pick optional services
from it.

### Product adapters

Tutti and TSH each own an adapter layer that:

- obtains the current workspace or room and authenticated user identity;
- captures an immutable session partition;
- maps the existing HTTP clients and snapshot repositories to shared ports;
- supplies product capability factories and their narrow dependencies;
- owns product copy, feature enablement, launch/reuse/close policy, and
  business-state projection;
- registers a product-owned class service/coordinator with
  `@tutti-os/infra/di` in the product's renderer composition root; and
- connects the resulting session to the React Workbench surface.

The long-term TSH target is therefore not only to consume the same kernel. Its
renderer also adopts the same class-DI composition style as Tutti through
`@tutti-os/infra/di`, replacing hook-owned host lifecycle. This is an official
renderer integration decision, not a dependency from the host package to the DI
framework.

The adapters are the only place where `workspaceId` can mean a Tutti workspace
and where TSH's Workbench `workspaceId` compatibility field can carry a room
ID. The shared kernel treats these as opaque scope IDs.

## Lifetime and partition rules

### Renderer singleton coordinator

There is exactly one coordinator in each renderer/window DI root. It may manage
zero or more sessions, but it is not a process-global static and it does not own
business entities. It owns only the index and lifecycle of sessions created in
that renderer.

Opening the same immutable partition twice is idempotent or returns an explicit
lease to the same session. Opening the same scope with a different immutable
partition must dispose and replace the old session before the new session can
publish host input.

### Disposable scope session

Each Tutti workspace or TSH room gets a disposable session. The session owns:

- the resolved contribution set and stable host-input projection;
- scope-local subscriptions and adapter leases;
- projection and dynamic-presentation bridges;
- scope-local repository/cache coordination that is not owned by the daemon;
- the attachment to the surface runtime handle; and
- cleanup for all resources acquired during session construction.

Disposal is idempotent. After disposal, async completions may not mutate cache,
publish host input, save a snapshot, or call a detached surface handle.

### Scope and snapshot partitions

The kernel uses two related identities:

- `WorkbenchScope`: product-visible logical scope;
- `WorkbenchSnapshotPartition`: immutable repository/cache key captured when a
  session starts.

Canonical mappings are:

| Product | Workbench scope        | Snapshot partition                                                     |
| ------- | ---------------------- | ---------------------------------------------------------------------- |
| Tutti   | `workspaceId`          | `workspaceId` under the existing local authenticated desktop authority |
| TSH     | control-plane `roomId` | `roomId` plus an immutable authenticated-user snapshot                 |

The TSH authenticated-user snapshot contains only stable identity needed for
partitioning, normally the authenticated user ID. It never contains a token or
mutable auth client. The user ID continues to be derived by desktopd for the
HTTP request; it is not accepted from a renderer request body. The renderer
partition prevents cache reuse, while desktopd's `(room_id, user_id)` key
remains the durable enforcement boundary.

If Tutti later supports switching durable user authorities within one local
profile, it must introduce a versioned partition mapping through its product
adapter. The shared kernel must not infer that policy.

## State ownership

| State                                                                    | Authoritative owner                                                       | Kernel/session role                                          | Forbidden owner             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------- |
| Snapshot schema, migrations, normalization                               | `@tutti-os/workbench-snapshot`                                            | Consume unchanged                                            | Product adapter             |
| Frame, display mode, restore frame, minimized state, stack, active shell | Workbench surface session plus daemon snapshot repository                 | Coordinate attachment and persistence port                   | Capability business service |
| Snapshot durability                                                      | `tuttid` for Tutti; desktopd SQLite keyed by `(room_id, user_id)` for TSH | Call repository port; maintain only recoverable client cache | Renderer session            |
| Node type/instance identity and dock affinity                            | Existing Workbench surface contracts and identity helpers                 | Preserve and validate ownership                              | Product profile remapping   |
| Contribution ordering and duplicate capability ownership                 | Host kernel using declared factory `order` then `id`                      | Resolve deterministically                                    | React render order          |
| Projected node presence                                                  | Owning product runtime/business service                                   | Forward live projection into the attached surface session    | Snapshot restore            |
| Terminal, agent, chat, app, file, transfer, and collaboration state      | Product daemon/control plane/domain service                               | Read/project through capability adapter                      | Host kernel or snapshot     |
| Dynamic dock badges, availability, and attention                         | Owning capability service/store                                           | Forward through stable state source                          | Static host-input rebuild   |
| Authenticated principal used for partitioning                            | Product authentication authority                                          | Hold immutable identity snapshot for one session             | Capability contribution     |
| React-only overlay/dialog/DOM state                                      | Product presentation adapter                                              | None, except commands/events across a narrow seam            | Shared kernel               |

## Invariants

1. A snapshot can restore shell presentation but can never create, delete, or
   become authoritative for a terminal, agent, chat, app, file, transfer, or
   collaboration business entity.
2. At most one live host session exists per immutable snapshot partition in one
   renderer coordinator, and every session is disposed before its partition is
   replaced.
3. TSH cache and persistence access for a room is partitioned by an immutable
   authenticated-user snapshot; credentials and user IDs are never supplied by
   capability contributions or persisted inside the Workbench snapshot.
4. A capability owns each contribution ID, node `typeId`, and dock entry ID
   exactly once. Resolution is deterministic and independent of React render
   order.
5. Dynamic business or dock state may update a stable session but may not
   recreate the coordinator, session, node definitions, or shell identities.
6. Session disposal cancels or invalidates all later async writes and callbacks;
   a disposed session cannot publish or persist state.
7. Shared code depends on product-neutral ports. Tutti and TSH adapters may
   depend on the kernel, but the kernel never imports either product.
8. Current `WorkbenchContribution`, snapshot schema, stable node identity,
   dock ordering/affinity, daemon API shapes, and business authority remain
   behaviorally compatible throughout Phase 0.
9. Host may depend on surface public contracts at type/declaration level;
   surface never depends on host, and neither a React runtime dependency nor a
   host/surface cycle is allowed.

## Compatibility constraints

The extraction is a structural change, not a contract redesign:

- no change to `WorkbenchContribution` or the explicit `WorkbenchHost` props;
- no snapshot schema or migration change;
- no change to projected/launched node ID helpers or existing IDs;
- no change to contribution merge precedence or product dock order;
- no change to Tutti's `/v1/workspaces/{workspaceID}/workbench` API;
- no change to TSH's `GET/PUT /v1/rooms/{roomId}/workbench` API;
- no change to daemon-side reconciliation ownership; and
- no movement of product business policy into a shared package.

Any implementation step that needs one of these changes must stop and propose a
separate contract decision instead of hiding it inside the host extraction.

## Rejected designs

### Product inheritance

Rejected: a shared base host class with `TuttiWorkbenchHost` and
`TSHWorkbenchHost` subclasses.

Inheritance would make product-specific lifecycle hooks part of the shared
contract, encourage protected-state coupling, and make constructor/override
order an implicit coordination protocol. The products are compositions of
capabilities, not substitutable host subtypes. Use a final coordinator/session
implementation with injected profiles and ports.

### Product-union mega-context

Rejected: one context such as `TuttiContext | TSHContext`, or an object with
dozens of optional Tutti and TSH services.

That shape moves the fork into runtime conditionals, exposes unrelated business
services to every factory, and makes absence ambiguous. Profiles declare stable
choices; narrow ports provide shared needs; capability adapters receive only
their own dependencies.

### Make `@tutti-os/workbench-surface` the product host

Rejected as the stable boundary. Surface owns shell mechanics and React
presentation. Adding product host coordination there would couple a headless
lifecycle concern to the UI package and make non-React testing and evolution
harder.

### Keep two hosts and share only tests

Rejected as the long-term target. A conformance suite is required, but tests
alone do not create one lifecycle owner. The current Tutti class and TSH hook
would continue to drift in disposal, partition, cache, and update semantics.

## Public package evaluation

### Preferred: `@tutti-os/workbench-host`

Benefits:

- names the coordination domain explicitly;
- can remain headless and class-based;
- can expose a small public API and a conformance test subpath;
- keeps `workbench-surface` focused on UI/shell mechanics; and
- gives TSH a release-based dependency rather than copied host code while both
  official renderers use the same `@tutti-os/infra/di` class composition style.

Costs:

- adds a public compatibility surface and fixed-release-group member;
- requires pack, beta, downstream, and stable release validation; and
- requires strict export discipline to avoid publishing Tutti product types.

This is the accepted target if Phase 0 proves that the public seam contains only
coordinator/session, profiles, ports, capability descriptors, and conformance
helpers.

### Alternative: `@tutti-os/workbench-surface/host`

This avoids another package and may be useful as a short-lived incubation
location. It is not preferred for stable because it couples headless host
coordination to React/surface release and dependency shape. If Phase 0 cannot
produce an independent package without a React runtime dependency or circular
dependency, the work must pause and reassess boundaries rather than silently
make this the permanent API.

### Alternative: Tutti-private kernel plus copied TSH adapter

This has the lowest immediate release cost and is acceptable only for the
Tutti-first proving step. It is not a completion state: TSH must consume a
released package for external validation, never a filesystem link or copied
source.

## Release decision

If extracted, `@tutti-os/workbench-host` joins the existing fixed npm release
group and uses its single shared version. It does not establish an independent
version or release workflow.

- Local beta validation uses `pnpm release:beta`, publishes with the `beta`
  dist-tag, and creates no git tag or manifest commit.
- Stable publication uses the repository's manual fixed-group workflow and the
  normal `packages-v<version>` tag.
- Stable publication also creates the normal tags for every existing
  `packages/**/go.mod`, including `packages/workbench/service/v<version>`.
- The TypeScript host package does not need its own `go.mod`; adding one only to
  obtain a tag is prohibited.
- If no Go code or contract changes, TSH beta validation continues using the
  last stable Workbench Go module. A Go beta distribution mechanism is outside
  this decision.

The durable fixed-group roster and all release automation must be updated in
one package-extraction PR. Before that edit, the implementation must audit and
reconcile any existing roster drift between release documentation and config;
it must not copy one stale list into another.

## Consequences

Positive consequences:

- both products share one lifecycle and partition model;
- React becomes an adapter rather than the owner of host coordination;
- product features stay independently contributable;
- auth and scope isolation become explicit and testable;
- the public Workbench surface and daemon contracts remain stable.

Costs and constraints:

- Tutti must first separate product policy from its current large host class;
- TSH must later replace hook-owned lifecycle with an adapter to the released
  coordinator/session;
- package API review and downstream beta validation become mandatory; and
- a coordinator/session abstraction adds value only if its public surface stays
  smaller than either product host.

## Open questions

1. Should the coordinator allow concurrent sessions in one renderer, or enforce
   one active session with a map-shaped API for future growth? Default: support
   a map internally and test multiple partitions without promising multi-view
   UI behavior.
2. Should the surface accept an externally created shell session, or should the
   host session initially expose stable `WorkbenchHost` input and attach the
   returned handle? Default: attach through the current public surface props and
   handle until an external-session API is justified independently.
3. Which Tutti snapshot metadata (currently product-owned wallpaper and
   onboarding fields) should remain in the snapshot repository adapter versus a
   dedicated product metadata port? Default: keep compatibility in the Tutti
   adapter during Phase 0 and extract only after conformance tests prove the
   ownership boundary.
