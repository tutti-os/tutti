# Connector Directory Convergence

> Status: implemented on 2026-08-19.
>
> Scope: the Tutti repository only. TSH and other external consumers are
> intentionally deferred.
>
> Baseline: tutti main at 74ba1915a on 2026-08-19.

## Implementation result

The migration was completed as one source-breaking change with no compatibility
aliases. The final owners, package exports, Go module identities, product
adapters, Agent GUI projection boundary, repository checks, release metadata,
and layered `AGENTS.md` files now match this document.

Focused Connector validation passes for all five Go modules, both npm packages,
Agent GUI, Desktop, Renderer component tests, package builds, package dry-runs,
generated contracts, ownership boundaries, lint, and type checking. The
changed-aware run passed 79 of 80 lanes; its only failing lane was the existing
full `services/tuttid` test lane. The same lane was the only failure in
`check:full`: two Agent Status tests observe a user-installed Claude executable
or credential, and one Workspace app-runner test intermittently times out while
retrying a port. Those tests do not execute Connector code and remain outside
this directory migration's change scope.

## Decision

Converge Connector code by architectural responsibility rather than
implementation language:

```text
contracts -> daemon -> runtime -> renderer
```

The actual dependency graph is not a linear call chain. The labels identify
ownership:

- Contracts owns Connector-specific cross-boundary protocols.
- Daemon owns lifecycle semantics, orchestration, and reusable daemon adapters.
- Runtime owns same-machine and managed-guest execution mechanics.
- Renderer owns frontend application services and every Connector-specific
  React implementation.

Go and TypeScript remain the natural implementations of these responsibilities,
but language is not a directory boundary.

This is a source-breaking directory migration. Old module paths, npm package
names, import aliases, and compatibility re-exports will be removed. Runtime
behavior and external protocols remain unchanged.

## Goals

- Make Connector ownership visible from the directory tree.
- Keep the existing Host, Daemon, Runtime, Renderer, and product-adapter
  architecture intact.
- Converge all Connector-specific React components, icons, default copy, and
  presentation primitives into one Renderer UI owner.
- Keep Agent-specific draft, prompt, catalog-refresh, and Host-navigation
  semantics in Agent GUI without leaving Connector-specific JSX there.
- Keep necessary frontend lifecycle, Market, View, and UI-state services in a
  React-free Renderer Application layer.
- Preserve the current acyclic Go module graph.
- Make architecture boundaries executable through package exports, repository
  checks, and layered AGENTS.md instructions.
- Complete the move in one atomic PR without temporary compatibility layers.

## Non-goals

- Changing Connector installation, authorization, reconciliation, execution,
  or recovery behavior.
- Changing HTTP paths, OpenAPI field meanings, event names or payloads,
  persisted data, manifest fields, status enums, error codes, authentication,
  or call ordering.
- Redesigning Connector UI, interaction, information density, or copy.
- Replacing the current Renderer Root, Lifecycle, StartupJob, View, or UiState
  service model.
- Moving Agent-owned draft or prompt semantics into Connector.
- Moving product-specific Desktop or tuttid composition into shared packages.
- Moving the market-neutral market-go client into Connector.
- Adding a new cross-process end-to-end test framework.
- Updating TSH or other external repositories.
- Publishing the new npm packages or Go modules as part of this change.

## Invariants

The migration is complete only when every invariant below is demonstrated:

1. HTTP, OpenAPI, event, persistence, and manifest semantics are unchanged.
2. Go lifecycle and Runtime behavior are unchanged.
3. Renderer state flow and service lifecycle are unchanged.
4. Connector UI behavior, layout, copy, loading, empty, error, authorization,
   selection, and success states remain equivalent.
5. Agent draft blocks and prompt projection remain equivalent, including
   connector-only submission.
6. Active source, configuration, CI, release metadata, and current
   documentation contain no old Connector paths or package names.
7. Historical specs may retain old names only as historical narrative or in an
   explicit migration note.
8. All new architecture guards and affected tests pass.

## Final directory structure

```text
packages/connector/
├── AGENTS.md
├── README.md
│
├── contracts/                              # @tutti-os/connector-contracts
│   ├── AGENTS.md
│   ├── package.json
│   ├── README.md
│   ├── src/
│   │   └── authorization/
│   │       └── v1/
│   └── openapi/
│       └── connector-market.v1.yaml
│
├── daemon/
│   ├── AGENTS.md
│   ├── core/                               # independent Go module
│   │   ├── go.mod
│   │   └── README.md
│   ├── application/                        # independent Go module
│   │   ├── go.mod
│   │   ├── README.md
│   │   └── adapters/
│   │       └── catalog/
│   └── adapters/
│       ├── sqlite/                         # independent Go module
│       │   ├── go.mod
│       │   └── README.md
│       └── controlplane/                   # independent Go module
│           ├── go.mod
│           └── README.md
│
├── runtime/                                # independent Go module
│   ├── AGENTS.md
│   ├── go.mod
│   ├── README.md
│   ├── agentgateway/
│   ├── artifact/
│   ├── command/
│   ├── implementationhost/
│   ├── mcp/
│   └── mcpserver/
│
└── renderer/                               # @tutti-os/connector-renderer
    ├── AGENTS.md
    ├── package.json
    ├── README.md
    └── src/
        ├── application/                    # React-free
        │   ├── contracts/
        │   ├── authorization/
        │   └── services/
        │       ├── lifecycle/
        │       ├── market/
        │       ├── view/
        │       └── ui-state/
        └── ui/                             # only Connector React owner
            ├── primitives/
            ├── catalog/
            ├── composer/
            ├── palette/
            ├── authorization/
            ├── dialogs/
            ├── toolbar/
            └── i18n/
```

Host integration remains with each product owner:

```text
services/tuttid/service/connector/
├── market/
└── mcp/

apps/desktop/src/renderer/src/features/connector/
├── adapters/
├── registration/
└── index.ts

packages/agent/gui/agent-gui/agentGuiNode/integrations/connector/
├── model/
├── controller/
└── index.ts
```

The Agent GUI integration directory contains no JSX. Mixed Agent surfaces may
mount components imported from Connector Renderer UI, but they do not implement
Connector visuals.

## Source-to-target mapping

| Current owner                                                                  | Target owner                                              | Notes                                                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| packages/connector/host                                                        | packages/connector/daemon/core                            | Preserve the independent Go module and Host lifecycle/Port semantics            |
| packages/connector/daemon                                                      | packages/connector/daemon/application                     | Preserve scheduling, recovery, lifecycle maintenance, and durable orchestration |
| packages/connector/daemon/catalog_source.go                                    | packages/connector/daemon/application/adapters/catalog    | Remains inside the Application Go module                                        |
| packages/connector/store-sqlite                                                | packages/connector/daemon/adapters/sqlite                 | Preserve the independent SQLite adapter module                                  |
| packages/clients/connector-controlplane                                        | packages/connector/daemon/adapters/controlplane           | Preserve the independent HTTP/WebSocket adapter module                          |
| packages/connector/runtime                                                     | packages/connector/runtime                                | Keep the Runtime as a top-level execution boundary                              |
| packages/connector/authorization-protocol                                      | packages/connector/contracts                              | Publish as the authorization/v1 subpath                                         |
| packages/connector/market/openapi                                              | packages/connector/contracts/openapi                      | Contracts package publishes the OpenAPI resource                                |
| packages/connector/market/src/contracts                                        | packages/connector/renderer/src/application/contracts     | These are Renderer domain and Host Port contracts, not wire schemas             |
| packages/connector/market/src/services                                         | packages/connector/renderer/src/application/services      | Preserve Root, Runtime, Lifecycle, StartupJob, View, and UiState semantics      |
| packages/connector/market/src/authorization/declarativeAuthorizationAdapter.ts | packages/connector/renderer/src/application/authorization | React-free authorization mapping                                                |
| packages/connector/market/src/authorization/AuthorizationViewRenderer.tsx      | packages/connector/renderer/src/ui/authorization          | React implementation                                                            |
| packages/connector/market/src/ui                                               | packages/connector/renderer/src/ui                        | All existing Market and Composer UI                                             |
| packages/connector/market/src/i18n                                             | packages/connector/renderer/src/ui/i18n                   | Connector UI owns default copy and its scoped runtime                           |
| apps/desktop/.../features/connector-market                                     | apps/desktop/.../features/connector                       | Desktop Backend, Event, Admission, registration, and navigation adapters        |
| services/tuttid/service/connectormarket                                        | services/tuttid/service/connector/market                  | Product service adapter                                                         |
| services/tuttid/service/connectormcp                                           | services/tuttid/service/connector/mcp                     | Product MCP service adapter                                                     |
| Agent GUI Connector JSX                                                        | packages/connector/renderer/src/ui                        | Re-express through neutral Connector props and semantic callbacks               |
| Agent GUI Connector draft/prompt logic                                         | agentGuiNode/integrations/connector                       | Remains Agent-owned and React-free                                              |

The following owners do not move:

- packages/clients/market-go remains the Market-neutral generated client.
- packages/clients/tuttid-ts remains the generated daemon client owner.
- packages/events/protocol remains the unified business-event owner.
- services/tuttid/wiring.go remains the concrete product composition root.
- Cross-domain Connector files in eventstream, managedruntime, and Agent
  runtime remain with those modules.

## Package and module identities

### Go

Keep five independent Connector modules:

```text
github.com/tutti-os/tutti/packages/connector/daemon/core
github.com/tutti-os/tutti/packages/connector/daemon/application
github.com/tutti-os/tutti/packages/connector/daemon/adapters/sqlite
github.com/tutti-os/tutti/packages/connector/daemon/adapters/controlplane
github.com/tutti-os/tutti/packages/connector/runtime
```

The separation is architectural rather than compatible scaffolding:

- Daemon Core is consumed by Application, Runtime, SQLite, Control Plane,
  Agent Daemon, and tuttid.
- Runtime depends on Agent Daemon process mechanics, while Agent Daemon consumes
  Connector Core for Composer catalog projection.
- Combining Core and Runtime would create a module release cycle.
- Concrete adapters must not become transitive dependencies of Core or Runtime.

packages/clients/market-go keeps its existing module identity and remains an
external dependency of Daemon Application.

### TypeScript

Create two public npm packages:

```text
@tutti-os/connector-contracts
@tutti-os/connector-renderer
```

Contracts exposes narrow resource/schema entries:

```text
@tutti-os/connector-contracts/authorization/v1
@tutti-os/connector-contracts/openapi/connector-market.v1.yaml
```

Renderer is one npm package with narrow responsibility entries:

```text
@tutti-os/connector-renderer/application
@tutti-os/connector-renderer/ui
@tutti-os/connector-renderer/i18n
```

Do not add a root barrel that combines Application and UI. This keeps
React-free consumers on the Application entry and makes accidental UI imports
detectable. The package remains physically discoverable by the repository's
existing packages/_/_ package globs.

The new npm and Go identities start from the current development version,
0.1.0. Old registry artifacts are not deleted and are not maintained through a
dual-publish path. This PR prepares manifests, changesets, pack verification,
and migration notes; it performs no external publication.

## Dependency direction

```text
connector/contracts
    ↑
    ├── connector/renderer/application
    │       ↑
    │       └── connector/renderer/ui
    │               ↑
    │               ├── agent-gui
    │               └── desktop
    │
    ├── connector/daemon/application
    └── product adapters where the wire contract is required

connector/daemon/core
    ↑
    ├── connector/daemon/application
    ├── connector/daemon/adapters/sqlite
    ├── connector/daemon/adapters/controlplane
    ├── connector/runtime
    ├── agent/daemon
    └── services/tuttid
```

Required negative boundaries:

- Contracts imports no Renderer code.
- Renderer Application imports no Renderer UI, React, DOM, Electron, Desktop,
  or Agent GUI code.
- Connector packages import no Agent GUI or Desktop code.
- Daemon Core imports no concrete adapter.
- Runtime imports no Daemon Application, SQLite, or Control Plane adapter.
- Shared Connector modules import no services/tuttid code.

## Renderer responsibilities

### Application

Renderer Application remains React-free and owns:

- Host-neutral Backend, Event, Admission, and domain contracts.
- Connector Market Root and module lifecycle.
- Startup jobs and dependency-safe disposal.
- Authoritative snapshot reconciliation and mutation revision fencing.
- Market state and operation intents.
- View building and render-ready snapshots.
- Shared dialog and UI-state service.
- Declarative authorization mapping that contains no React rendering.

It obtains transport, event subscription, authentication admission, and
navigation through injected Ports. It does not construct HTTP clients, read
Electron globals, or access Desktop state.

### UI

Renderer UI is the only owner of Connector-specific React code:

```text
primitives/
  ConnectorIcon
  ConnectorStatus
  ConnectorSelectionChip

composer/
  ConnectorComposerMenu
  ConnectorComposerControl
  ConnectorSelectionList

palette/
  ConnectorPaletteItem
```

It also owns the existing catalog, dialogs, toolbar, authorization renderer,
default i18n resources, and scoped i18n runtime.

The UI accepts Connector-owned, neutral items, labels/runtime, snapshots, and
semantic callbacks. It imports no Agent GUI draft type, AgentGUIProviderSkill
option, workspace settings store, Desktop global, or generated daemon client.

Use the repository UI System's public components, icons, and semantic tokens.
Preserve the current layout, sizing, state coverage, and interaction behavior.
Remove the Agent GUI-local Connector icon and visual implementation once all
consumers use Renderer UI.

### Agent GUI bridge

Agent GUI retains:

- AgentComposerDraft Connector block ownership.
- Connector selection updates scoped to the active Agent draft.
- Prompt block validation and connector-only submission.
- Provider/daemon capability projection into neutral Connector items.
- Connector catalog invalidation handling.
- Host navigation and settings intents.
- Slash-command and mixed Composer ordering semantics.

Move these concerns into agentGuiNode/integrations/connector as React-free
model/controller code. Mixed Agent GUI views consume Connector UI components.
For example:

- Replace the local ComposerConnectorsMenu wrapper with a neutral projection
  plus ConnectorComposerMenu.
- Replace Connector-specific JSX in ComposerDraftAttachments with
  ConnectorSelectionList.
- Replace Connector-specific palette row rendering with ConnectorPaletteItem.
- Keep the outer Agent Slash Palette and attachment surface in Agent GUI.

## Product adapters

### Tutti daemon

Collect the product-specific service adapters under:

```text
services/tuttid/service/connector/
├── market/
└── mcp/
```

Keep eventstream, managedruntime, agent runtime, and root wiring code with their
existing owners. Concrete construction remains in services/tuttid/wiring.go.

### Desktop

Collect renderer integration under:

```text
apps/desktop/src/renderer/src/features/connector/
├── adapters/
│   ├── desktopConnectorBackend.ts
│   ├── desktopConnectorEvents.ts
│   └── desktopConnectorAdmission.ts
├── registration/
└── index.ts
```

Desktop implements Renderer Application Ports and owns generated-client,
Electron, account, workspace-settings, and product-navigation access.

## AGENTS.md hierarchy

Generate the Connector instruction hierarchy with the writing-for-agents skill:

```text
packages/connector/AGENTS.md
packages/connector/contracts/AGENTS.md
packages/connector/daemon/AGENTS.md
packages/connector/runtime/AGENTS.md
packages/connector/renderer/AGENTS.md
```

Use progressive disclosure:

- packages/connector/AGENTS.md contains the routing map, cross-area invariants,
  and strong pointers to the durable architecture documents.
- Contracts instructions define the contract-first sequence and cross-language
  completion criteria.
- Daemon instructions define Core, Application, and Adapter ownership.
- Runtime instructions define execution-plane, process, path, security, and
  Windows requirements.
- Renderer instructions define Application/UI separation, neutral integration
  contracts, UI System/i18n ownership, and UI completion criteria.

Keep full state machines and data-flow explanations in architecture documents,
not AGENTS.md. Update packages/AGENTS.md with a trigger-first pointer requiring
Connector work to read packages/connector/AGENTS.md. Point validation rules to
the repository Testing and Static Analysis documents, adding only
Connector-specific checks locally.

## Architecture and documentation updates

Current durable documentation must describe the new shape:

- Rename docs/architecture/connector-market.md to
  docs/architecture/connector.md.
- Keep docs/architecture/connector-remote-mcp.md as a focused reference.
- Update docs/architecture/README.md.
- Update docs/architecture/project-structure.md.
- Update the Connector sections in docs/architecture/agent-gui-node.md.
- Update docs/conventions/static-analysis.md.
- Update docs/conventions/npm-package-release.md.
- Update packages/AGENTS.md.
- Replace old package READMEs with the new responsibility-owner READMEs.
- Keep docs/conventions/troubleshooting/connector-market.md focused on the
  user-visible Market surface and repair stale source links.

Dated specs and plans remain historical records. Add a moved/superseded note or
repair a dead link when needed; do not rewrite their historical architecture as
if the new layout existed at the time.

## Migration workflow

The change ships in one atomic PR. Logical commits may separate preparation,
moves, consumer rewrites, guards, and documentation, but the merged result has
no compatibility layer.

### 1. Freeze the baseline

- Record current module/package tests and generated checks.
- Inventory every active old path, package name, module import, OpenAPI
  fragment, release entry, and static-check allowlist.
- Record the current public exports and UI behaviors covered by tests.

Completion criterion: every active reference has an owner and target mapping.

### 2. Move Contracts

- Move authorization schemas and validation into connector/contracts.
- Move the local Connector OpenAPI fragment into contracts/openapi.
- Create @tutti-os/connector-contracts with narrow subpath exports.
- Update protocol consumers and generated-check selection.

Completion criterion: Contracts builds and tests without Renderer, React, or
host dependencies; composed OpenAPI output remains semantically unchanged.

### 3. Move Go ownership

- Move Host to daemon/core.
- Move Daemon to daemon/application.
- Move Store SQLite and Control Plane to daemon/adapters.
- Move Catalog Source into daemon/application/adapters/catalog.
- Keep Runtime top-level and market-go in packages/clients.
- Rewrite module declarations, imports, replacements, and go.work entries.
- Run gofmt and go mod tidy for every affected module.

Completion criterion: all five Connector modules and services/tuttid compile
and test independently with the original dependency direction.

### 4. Build Renderer Application and UI

- Create @tutti-os/connector-renderer.
- Move React-free contracts, lifecycle, services, state, View, and
  authorization mapping into application.
- Move all Connector React code and i18n into ui.
- Split mixed authorization and root export surfaces.
- Publish only /application, /ui, and /i18n.

Completion criterion: Application passes the React-free boundary guard and UI
preserves all existing state/interaction tests.

### 5. Converge Agent GUI and Desktop integration

- Extract neutral Connector UI props and callbacks.
- Move every Connector-specific JSX implementation into Renderer UI.
- Move Agent-owned non-UI logic into integrations/connector.
- Move Desktop integration into features/connector.
- Keep generated clients and workspace/product navigation in Desktop adapters.

Completion criterion: Agent GUI contains no Connector-specific JSX
implementation or local Connector visual asset; Agent draft, prompt, menu, and
event tests remain equivalent.

### 6. Converge tuttid adapters

- Move connectormarket and connectormcp into service/connector.
- Preserve eventstream, managedruntime, Agent runtime, and root wiring owners.
- Rewrite imports without changing API, event, or composition behavior.

Completion criterion: tuttid tests pass and wiring remains the only concrete
composition root.

### 7. Update repository tooling and release metadata

- Update Go lint module roots and their tests.
- Add the Control Plane module to Go lint coverage.
- Update HTTP Client Funnel scan roots for Connector Daemon adapters.
- Replace npm package dependencies and regenerate pnpm-lock.yaml.
- Update tsup entries, package files, repository directories, and Tailwind
  source metadata.
- Update the OpenAPI fragment path and API-generated relevance selector.
- Update OpenAPI fragment tests.
- Replace old package names in active changesets and release conventions.
- Add and register check:connector-boundaries.

Completion criterion: changed-aware discovery selects every moved module,
package, contract, and boundary check.

### 8. Generate instructions and update documentation

- Generate the layered AGENTS.md files with writing-for-agents.
- Update current architecture, structure, testing/static-analysis, release, and
  troubleshooting references.
- Add the Connector root navigation README.

Completion criterion: an Agent entering any target subtree is routed to the
correct owner rules without duplicated architecture prose.

### 9. Remove old identities

- Delete old directories after their contents are mapped.
- Remove old package exports, package names, module paths, aliases, and
  compatibility barrels.
- Exclude historical specs from the active-reference search and inspect every
  remaining match manually.
- Do not move dist, node_modules, or other local build artifacts.

Completion criterion: active source, configuration, CI, release metadata, and
current docs contain zero old Connector identities.

### 10. Verify

Run the focused and repository-wide validation matrix below.

Completion criterion: every command passes, generated files are clean, and
git diff contains only the planned migration.

## Required configuration updates

### Go

- go.work and go.work.sum.
- Five moved module declarations and sums.
- services/tuttid go.mod replacements and sums.
- packages/agent/daemon references to Daemon Core.
- Every Go source/test import of the old Host, Daemon, Store, Runtime, or
  Control Plane module path.
- tools/scripts/run-check-changed-targets.mjs GO_LINT_MODULE_ROOTS and its
  tests.

market-go remains at packages/clients/market-go. Its generated source lock and
sync target do not move.

### TypeScript and package tooling

- contracts and renderer package manifests.
- Renderer tsup and TypeScript entry configuration.
- Agent GUI and Desktop package dependencies.
- pnpm-lock.yaml.
- Desktop Tailwind source reference.
- Existing architecture guard replacement.
- Active changesets that name connector-market or
  connector-authorization-protocol.

Both new npm packages remain at packages/_/_ depth, so the current workspace,
typecheck, test, changed-aware, and npm release discovery globs continue to
find them.

### OpenAPI and generated checks

- services/tuttid/api/openapi/tuttid.v1.yaml fragment path.
- tools/scripts/openapi-fragments.test.mjs package/resource expectations.
- tools/scripts/repository-checks.mjs API-contract relevance for
  packages/connector/contracts/openapi.

The source contract moves, but the generated API semantics must remain
unchanged.

## Boundary enforcement

Add a repository-level command:

```sh
pnpm check:connector-boundaries
```

Register it in the repository-check boundaries group so check:changed and
check:full execute it when relevant. It must enforce at least:

```text
contracts -X-> renderer
renderer/application -X-> renderer/ui
renderer/application -X-> React, DOM, Electron, Desktop, AgentGUI
packages/connector -X-> agent-gui, desktop
daemon/core -X-> concrete adapters
runtime -X-> daemon/application, sqlite, controlplane
```

Extend the HTTP Client Funnel check to cover Connector Daemon network adapters.
Preserve existing UI, Renderer, Electron Runtime, Agent Activity Runtime, and
i18n boundary checks.

## Validation

Run commands from the repository root unless a subshell says otherwise.

### Focused Go

```sh
(cd packages/connector/daemon/core && go test ./...)
(cd packages/connector/daemon/application && go test ./...)
(cd packages/connector/daemon/adapters/sqlite && go test ./...)
(cd packages/connector/daemon/adapters/controlplane && go test ./...)
(cd packages/connector/runtime && go test ./...)
(cd services/tuttid && go test ./...)

pnpm test:go
pnpm build:go
pnpm lint:go
```

### Focused TypeScript

```sh
pnpm test:ts -- --packages-json '["@tutti-os/connector-contracts","@tutti-os/connector-renderer","@tutti-os/agent-gui","@tutti-os/desktop"]'

pnpm --filter @tutti-os/connector-contracts typecheck
pnpm --filter @tutti-os/connector-renderer typecheck
pnpm --filter @tutti-os/agent-gui typecheck
pnpm --filter @tutti-os/desktop typecheck

pnpm --filter @tutti-os/connector-contracts build
pnpm --filter @tutti-os/connector-renderer build
pnpm --filter @tutti-os/agent-gui build
pnpm --filter @tutti-os/desktop build

pnpm release:pack:check -- --packages-json '["@tutti-os/connector-contracts","@tutti-os/connector-renderer"]'
```

### Boundaries and generated contracts

```sh
pnpm check:connector-boundaries
pnpm check:ui-boundaries
pnpm check:renderer-boundaries
pnpm check:electron-runtime-boundaries
pnpm check:agent-activity-runtime-boundaries
pnpm check:i18n
pnpm check:api-generated
pnpm check:event-protocol-generated
pnpm test:tools
```

### Agent GUI behavior

Keep or relocate coverage for:

- Connector Composer loading, cached refresh, connection/authorization status,
  selection, ordering, and quick-menu limits.
- Connector selection chips and removal.
- Slash Palette Connector grouping and state.
- Connector catalog projection and Host visibility gating.
- Structured Connector draft blocks, key normalization, connector-only
  submission, and prompt-item projection.
- Catalog invalidation from tuttid event through Desktop to Agent GUI refresh.

There is no new cross-process E2E in this migration. Existing segmented tests
must continue to close the event and state-flow chain.

### Final repository gates

```sh
pnpm check:changed -- --dry-run
pnpm check:changed -- --push-ready
pnpm check:full
```

check:changed must select the new packages, all five Go modules, generated API
checks, boundary checks, and affected host consumers.

## Risks and mitigations

| Risk                                                      | Mitigation                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Go module release cycle                                   | Preserve five module boundaries; keep Runtime separate from Daemon Application                   |
| Application accidentally gains React                      | Narrow subpath exports plus check:connector-boundaries                                           |
| Renderer UI imports Agent GUI types                       | Neutral Connector items, snapshots, and callbacks                                                |
| A moved module silently misses lint/test selection        | Update go.work, GO_LINT_MODULE_ROOTS, relevance selectors, and their tests                       |
| Connector OpenAPI changes stop selecting generated checks | Add contracts/openapi to API-contract relevance                                                  |
| Network adapters bypass HTTP policy                       | Extend HTTP Client Funnel coverage                                                               |
| Agent prompt behavior changes during JSX extraction       | Preserve Agent-owned projection and focused draft/prompt tests                                   |
| UI appearance changes                                     | Use existing UI System and retain current interaction tests and manual smoke comparison          |
| Active changesets point to removed npm packages           | Rewrite them to contracts or renderer ownership                                                  |
| External hosts cannot find new identities                 | Do not update external repositories now; keep old registry versions and document the replacement |

## Rollback

No database or protocol migration is introduced. Before publication, rollback
is a full PR revert:

- restore the old source tree and package/module identities;
- restore old OpenAPI fragment and tooling references;
- remove the new boundary checks and AGENTS routing added only for the new
  shape.

Do not leave a partially reverted compatibility layer. If a problem is found
after merge but before publication, revert the atomic PR and repair the plan.

## Acceptance criteria

- The final directory tree matches this plan.
- All five Go modules retain the current dependency direction and pass their
  tests independently.
- @tutti-os/connector-contracts contains no Renderer dependency.
- @tutti-os/connector-renderer/application contains no React or host-specific
  dependency.
- Every Connector-specific React implementation lives under renderer/src/ui.
- Agent GUI owns only Agent-specific Connector projection and controller
  semantics.
- Desktop and tuttid adapters are grouped under their owner-specific Connector
  directories.
- market-go, tuttid-ts, and unified event definitions remain with their current
  owners.
- API, event, persistence, manifest, lifecycle, and UI behavior are unchanged.
- No active old path, npm package name, Go module path, alias, or compatibility
  export remains.
- Layered AGENTS.md instructions and current architecture documentation describe
  and enforce the new ownership.
- Focused validation, release pack checks, check:changed --push-ready, and
  check:full pass.
- The PR prepares new 0.1.0 package/module identities without publishing them
  or modifying external repositories.
