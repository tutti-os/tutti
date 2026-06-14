# Desktop Layering

This document defines the layering rules for `apps/desktop`.

## Document Authority

This is the authoritative document for the durable directory shape and ownership model inside `apps/desktop`.

Other documents should stay shorter:

- [docs/architecture/project-structure.md](../architecture/project-structure.md) summarizes the desktop area at repository scope
- [apps/desktop/AGENTS.md](../../apps/desktop/AGENTS.md) gives execution rules for changes inside `apps/desktop`

If the durable desktop directory shape or ownership model changes, update this document first, then update the summaries that point to it.

## Purpose

The desktop app is an Electron shell around `tuttid`.

Its job is to provide:

- window lifecycle
- preload bridge exposure
- Electron and OS integration
- local daemon supervision

It must not become a second business layer.

## Current Layout

```text
apps/desktop/
  src/
    main/
    preload/
    renderer/
    shared/
```

Current concrete shape is still intentionally small:

- `main` contains bootstrap composition, daemon supervision, host access, transport, IPC, update, generated defaults, logging, and window modules
- `preload` currently boots through a single entrypoint
- `renderer` currently resolves dashboard and workspace window shells from one bundle
- `renderer` organizes growing UI behavior as feature modules with service-owned state
- `shared` is used for narrow desktop-local contracts and i18n resources shared across main, preload, and renderer

The rules below describe both the current implementation and the allowed growth path.

## Recommended Ownership Shape

The desktop tree should be read by ownership, not as a checklist of required files.
Concrete filenames may evolve; preserve the responsibilities and dependency direction below.

```text
apps/desktop/src/
  main/
    daemon/
    generated/
    host/
    ipc/
    desktopAppLifecycle.ts
    desktopAppServices.ts
    desktopDaemonRuntime.ts
    desktopHostServices.ts
    transport/
    update/
    windows/
  preload/
    entries/
    api/
  renderer/
    src/
      app/
        windows/
          dashboard/
          workspace/
      features/
        <feature>/
          services/
            <feature>Service.interface.ts
            <feature>Types.ts
            register<Feature>Services.ts
            internal/
              adapters/
          ui/
      i18n/
      lib/
  shared/
    contracts/
    errors/
    i18n/
```

Reading rules:

- `main/host/*` owns host-side desktop capabilities such as file dialogs, workspace window handoff, and host-assisted workspace file access
- `main/desktopDaemonRuntime.ts` owns daemon endpoint, client, and managed-process runtime composition
- `main/desktopHostServices.ts` owns host-side service composition such as preferences, file dialogs, and workspace launch wiring
- `main/desktopAppServices.ts` composes daemon runtime, host services, and updater into the app-facing service set used by bootstrap
- `main/desktopAppLifecycle.ts` owns Electron application lifecycle event registration
- `main/windows/*` are Electron window shells, not business modules
- `main/windows/*` owns native window intents such as close and development reload shortcuts; renderer should respond to typed close requests instead of inferring native lifecycle from `beforeunload`
- `preload/entries/*` are capability-entry assembly points, even if only one entry exists today
- `renderer/src/app/windows/*` are renderer window composition shells such as `dashboard` and `workspace`
- `renderer/src/features/*` are reusable renderer feature modules
- `renderer/src/features/*/services/internal/**` is private implementation for the owning feature
- desktop business-facing capabilities should usually surface through `ipc/*` and `preload/api/*`
- `shared/contracts/*` is for stable desktop-local bridge contracts, not a general utility bucket
- `shared/errors/*` owns desktop-local error codes and non-Electron error classification shared across desktop layers
- `shared/i18n/*` owns desktop-local i18n resources, typed translation helpers, and app-level i18n-runtime composition shared across desktop layers

When adding or moving a desktop directory, update this ownership shape only when the new directory creates a durable boundary. Do not add every new implementation file to this document.

## Layer Responsibilities

## Desktop I18n Ownership Rule

Desktop i18n resources should be organized by ownership, not by where they are rendered.

Rules:

- keep desktop-owned product i18n resources in `src/shared/i18n/*`
- keep reusable package default i18n resources in the owning package instead of copying those strings into `apps/desktop`
- compose the renderer app-level i18n runtime from desktop-owned resources plus reusable package default i18n resources
- let host overrides win over package defaults during runtime merge
- keep user-facing error i18n resources under the desktop i18n layer, even when the error semantics originate from shared protocol clients

Current ownership model:

- `apps/desktop/src/shared/i18n/*` owns desktop launcher i18n resources, workspace host i18n resources, desktop workbench product i18n resources, and desktop error i18n resources
- reusable package defaults such as file-manager i18n resources and generic workbench window-chrome i18n resources stay in their owning `packages/*` modules
- `apps/desktop/src/renderer/src/i18n/index.tsx` merges desktop-owned i18n resources with package defaults into one app-level i18n runtime

Do not duplicate package default strings inside `apps/desktop/src/shared/i18n/*` unless the desktop app is intentionally taking ownership of that wording as a product override.

### `src/main`

`main` owns Electron-specific capabilities and the controlled bridge to `tuttid`.

Current responsibilities include:

- app bootstrap
- app-service composition
- window creation
- daemon start and stop
- transport endpoint resolution
- IPC registration
- desktop main-process logging
- desktop update integration
- generated desktop defaults consumption

`main` may:

- know managed loopback backend details
- supervise `tuttid`
- call Electron-native APIs

`main` must not:

- implement business rules
- reinterpret business workflows
- hold complex business state that belongs in `tuttid`

If logic is not Electron-specific, it should usually move out of `apps/desktop`.

### Main Composition Rule

Keep `main` composition layered and explicit.

Preferred shape:

- `bootstrap.ts` coordinates startup order and top-level error handling
- `desktopAppServices.ts` assembles the service set that the app needs at runtime
- `desktopDaemonRuntime.ts` assembles managed-local-backend concerns
- `desktopHostServices.ts` assembles host-facing service concerns
- `desktopAppLifecycle.ts` registers Electron app lifecycle listeners
- `ipc/*` adapts typed host and runtime services into preload-facing handlers

Do not collapse these responsibilities back into one long bootstrap file once
the boundaries exist.

Lifecycle-specific rule:

- when desktop shutdown depends on daemon cleanup, `before-quit` should act as an async gate instead of firing cleanup and exiting immediately
- managed `tuttid` shutdown, listener-info cleanup, and similar teardown work should finish before the final app quit path resumes
- lifecycle tests should cover the quit gate whenever desktop changes alter daemon-stop timing

### Main IPC Rule

Keep `main/ipc/*` thin.

Preferred shape:

- `ipc/*` binds channel names to typed handlers
- `ipc/handle.ts` owns the shared `ipcMain.handle(...)->toDesktopIpcResult(...)` wrapper
- `main/host/*` owns host-side payload normalization, window broadcast, file dialog use, and other native side effects
- `main/update/*` owns updater-specific payload normalization and updater-facing access helpers
- `shared/contracts/*` may own the typed `channel -> payload/result` mapping used by both preload invoke helpers and main IPC registration

Do not grow `register*Ipc` files into ad hoc business or host orchestration
surfaces once a typed access/helper layer exists.

Normalization-specific rule:

- host access layers should return durable product-shaped values, not raw Electron dialog outputs
- updater access layers should validate the full preload contract instead of silently coercing unsupported fields
- examples include deriving a usable workspace name from selected local directories and rejecting unsupported update channel values at the access boundary

### `src/preload`

`preload` is the renderer-facing desktop SDK layer.

Current state:

- desktop currently uses one preload entrypoint that composes the typed API surface

It should:

- expose typed APIs such as `window.tutti.runtime.getBackendConfig()`
- hide IPC channel names
- define capability surfaces per window when needed

It should not:

- expose a generic `invoke(channel, payload)` surface to renderer code
- own business orchestration
- know daemon endpoint details

### `src/renderer`

`renderer` is a consumer of desktop capabilities.

Current state:

- renderer currently uses one React bundle and resolves window shells by startup view
- renderer window shells create window-scoped dependency containers and assemble features
- feature services own renderer-local state, commands, and preload adapters

It should:

- keep window shells under `renderer/src/app/windows/*`
- organize reusable product UI by feature where practical as the workspace interior grows
- keep feature UI under `renderer/src/features/<feature>/ui/*`
- keep feature service public surfaces under `renderer/src/features/<feature>/services/*`
- keep feature service implementation under `renderer/src/features/<feature>/services/internal/**`
- use `@tutti-os/infra/di` for renderer feature service tokens and window-scoped composition
- expose feature stores to UI as readonly state and mutate them only inside the owning service
- consume shared tokens, icons, and primitives from `@tutti-os/ui-system`
- prefer the `@tutti-os/ui-system` root export for runtime imports instead of reaching into package internals
- load `@tutti-os/ui-system/styles.css` once from the renderer style entrypoint
- call typed preload APIs
- consume a typed tuttid client created by renderer window or platform composition from preload-provided runtime config

It should not:

- import Electron APIs directly
- let feature UI or feature services construct daemon clients
- discover or derive daemon transport endpoints
- import another feature's `services/internal/**`
- mutate another module's feature store directly from UI
- recreate a second design system inside `apps/desktop`
- deep-import from `@tutti-os/ui-system` internal source files or per-file component paths

## Renderer Feature Rule

Renderer features are organized around a feature-owned service.

The preferred feature shape is:

```text
renderer/src/features/<feature>/
  index.ts
  services/
    <feature>Service.interface.ts
    <feature>Types.ts
    register<Feature>Services.ts
    internal/
      <feature>Service.ts
      <feature>Store.ts
      <feature>Model.ts
      adapters/
  ui/
    use<Feature>Service.ts
    <Feature>.tsx
```

Rules:

- `services/*.interface.ts` declares the DI token and public service interface.
- `services/*Types.ts` contains public state and view-facing types.
- `services/register*Services.ts` registers the feature service for a window container.
- `services/internal/**` contains concrete service, store, model, and adapters.
- `ui/*` subscribes to the feature service store and calls service commands.
- `index.ts` exports only the stable feature surface needed by window composition or other features.

Do not create empty template files. Add optional files such as `<feature>Dependencies.ts` only when a feature has real external dependencies that are not already represented by another public service interface.

## Renderer Data Flow Rule

Renderer features should keep the data layer, logic layer, and UI layer distinct.

Rules:

- feature services are the logic boundary for assembling commands, adapters, request flow, and side effects
- feature stores are the data boundary for UI-facing state
- reducers or equivalent pure transition helpers should own deterministic state changes when store mutations become non-trivial
- selectors should own derived render data, filtering, grouping, and presentation-ready projections
- UI should render from state-library snapshots (currently `valtio` store snapshots) and call service commands in response to user events

Do not push orchestration into React components just because the workflow starts from a click, route, or subscription. If the flow needs to combine preload APIs, daemon data, local state, derived flags, or cross-step error handling, it belongs behind the owning service and store contract.

## Renderer Store Rule

Renderer service stores are for UI responsiveness, not daemon-owned durable state.

Rules:

- the feature service owns the store and all mutations
- UI reads `service.store` through a reactive snapshot hook
- UI invokes service commands for writes and side effects
- public service interfaces should expose readonly store types
- concrete mutable stores should stay under `services/internal/**`

This keeps rendering responsive while preserving the service as the feature's logic and state authority.

### Workspace Agent Activity Source Of Truth

Workspace agent activity is a renderer feature-service concern, not an AgentGUI
or MessageCenter local store concern.

Rules:

- register one `WorkspaceAgentActivityService` in the workspace window
  container
- pass that service into AgentGUI, MessageCenter, and other workspace workbench
  contributions that need agent activity
- keep controller/cache ownership inside `WorkspaceAgentActivityService`
- use the shared business-event stream only as a live update signal
- reconcile session and message state through the normal `tuttid` HTTP client
  APIs, including message `afterVersion` reads after reconnect

Do not reintroduce a per-session SSE client, a workspace-scoped SSE client, or a
second renderer-side agent activity controller when a consumer can use
`WorkspaceAgentActivityService`.

## Renderer React Boundary Rule

Treat fewer `useEffect` calls as a core architecture constraint, not just a style preference.

React components should stay close to DOM concerns: render snapshots, handle DOM events, and subscribe to external state through the feature's UI hook. Feature-level data flow belongs in services, stores, reducers, and selectors.

React effects are escape hatches for synchronizing with real external systems such as browser APIs, timers, subscriptions, and imperative third-party widgets. They should not become the default place for feature orchestration, derived state, command sequencing, or cross-feature coordination.

When a component needs an effect to keep local state in sync with other state, prefer moving that flow into the owning service, reducer, selector, or a small subscription hook. UI event handlers should call service commands; they should not directly mutate stores or coordinate business workflows.

## Renderer Render Stability Rule

Treat render stability as a feature-boundary concern, not as a late micro-optimization pass.

The renderer is not a traditional React app where components are expected to absorb most orchestration and synchronization work. `tutti` prefers logic and view separation: services own commands and side effects, stores own UI-facing state, selectors own derived render data, and React stays focused on subscriptions, DOM events, and presentation.

Rules:

- in the desktop renderer, treat the renderer build's React Compiler pass as the default memoization baseline; do not cargo-cult `React.memo`, `useMemo`, or `useCallback` into every component
- reach for handwritten memoization only when it expresses a real cache boundary, stabilizes a known hot prop surface, or profiling shows the compiler and current structure are not enough
- split UI by ownership and update frequency; do not let one large container mix unrelated high-churn state such as text input, polling state, panel visibility, and broad workspace shells
- keep expensive projection work out of raw render paths; filtering, grouping, sorting, and presentation-ready view-model shaping should live in selectors or in narrowly-scoped memoized projections
- subscribe as narrowly as the rendered surface needs; broad store subscriptions inside large container components defeat the value of fine-grained state updates
- keep hot props stable across render boundaries when they feed large subtrees or repeated list rows; large object literals, action bags, and repeated inline handler creation should not be the default shape at those boundaries
- prefer explicit event handlers, selector inputs, reducer transitions, and service commands over effect-driven local-state synchronization
- use `startTransition` or `useDeferredValue` only for clearly non-urgent UI updates or known expensive derived renders when a feature intentionally trades immediacy for smoother interaction

Practical review questions:

- is this component doing orchestration, projection, and rendering at the same time
- would a small state change here force unrelated UI regions to re-render
- should this derived data move into a selector or service-owned projection instead of being recomputed during every render
- is this list or subtree receiving unstable object or function props that could be avoided by better boundaries
- is a `useEffect` compensating for state placement that should be fixed structurally instead

Avoid these renderer anti-patterns:

- giant top-level components that accumulate unrelated state domains and then fan that churn into large child trees
- expensive projection functions executed directly inside render without a selector boundary or a narrowly-scoped memoized projection
- large inline `labels`, `actions`, or similar object literals passed through hot component boundaries
- broad store subscriptions in large container components that only need a smaller derived slice
- list rows that recreate multiple inline handlers or helper objects on every parent render
- `useCallback` dependencies that point at unstable object properties instead of a stable command boundary
- defining helper components or heavy render helpers inside another component when they can be extracted or hoisted

Prefer fixing structure before adding defensive memoization. In this repository, a better service boundary, selector, store subscription, or component split is usually the right first move.

## Renderer DI Rule

Renderer DI is used for feature composition and replaceable capabilities.

Rules:

- use `@tutti-os/infra/di` for service tokens and window-scoped containers
- window shells create the container and register the features they compose
- feature services may depend on other public service interfaces or on feature-local adapters
- prefer explicit registration in `renderer/src/app/windows/*/create*Container.ts`
- do not use DI as a global service locator from arbitrary UI components
- do not import another feature's `services/internal/**`; use its public interface or feature `index.ts`

Feature-to-feature dependencies should be wired by the window composition layer unless a direct dependency on another feature's public service interface is intentionally part of the feature contract.

Renderer DI should distinguish feature services from host adapters:

- use `@I<Feature>Service` tokens for public feature services that other renderer features may depend on
- use `@I<Capability>Service` tokens for shared renderer capabilities that are host-agnostic and reusable across feature services, such as `INotificationService`
- pass external capabilities as explicit adapter or registration parameters when they are not renderer feature services, including `tuttid` clients, event-stream clients, preload host APIs, platform APIs, runtime APIs, browser APIs, and terminal command runners
- keep host-specific adaptation at the window composition or feature registration boundary, then inject public service dependencies through the DI container
- do not create thin DI wrapper services only to rename a preload or daemon client; add a service token only when there is a real renderer-owned contract or shared capability

Notification-specific rule:

- feature services that need user-visible feedback should depend on `INotificationService` instead of receiving ad hoc toast callbacks from the window shell
- UI-only feedback may stay in UI code when it is purely local presentation behavior, but repeated or cross-step notification logic should move behind the owning service
- actionable notifications should get a dedicated contract when needed instead of overloading the basic notification service with workflow-specific button semantics

The mechanical guard for private feature implementation imports is:

```sh
pnpm check:renderer-boundaries
```

The staged-file variant is:

```sh
pnpm check:renderer-boundaries:staged
```

Workspace Workbench is stricter than the generic renderer feature rule because
it is a product host adapter for shared Workbench packages. Its UI must use
public service or controller seams instead of importing
`workspace-workbench/services/internal/**`. See [Workbench](./workbench.md).

## Renderer Preload Access Rule

Treat `window.tutti` as a renderer composition-root input.

Rules:

- window container files under `renderer/src/app/windows/**/create*Container.ts` may read `window.tutti` to pass the typed preload API into feature registrations
- feature services should receive preload capabilities through explicit adapters created by their registration function
- feature UI, feature services, renderer libraries, and ordinary app files must not read `window.tutti` directly
- `renderer/src/global.d.ts` may declare `Window.tutti` for type support

The mechanical guard is part of:

```sh
pnpm check:renderer-boundaries
```

### `src/shared`

`shared` is intentionally narrow.

Only place code here when it is:

- stable
- clearly cross-cutting
- not strongly owned by `main`, `preload`, or `renderer`

Do not turn `shared` into a generic bucket for convenience extraction.

## Call Path Rule

Desktop feature calls should choose one of three paths by responsibility:

```text
renderer -> managed localhost tuttid
renderer -> preload -> IPC -> main native capability -> OS
renderer -> preload -> IPC -> main host-assisted flow -> tuttid and OS
```

This rule keeps the layers understandable:

- renderer stays focused on UI and business-facing backend calls
- preload stays focused on typed host capability exposure and runtime bootstrap metadata
- main stays focused on Electron, daemon supervision, local process integration, and narrow host-assisted flows

Ordinary business queries, mutations, and streams should use the typed
renderer-side `tuttid` client. Host capabilities such as file pickers, shell
open, updater, preferences, and window lifecycle should go through preload and
main. Flows that need both native host authority and daemon authority should
stay explicit and few.

## Transport Boundary Rule

`apps/desktop` treats transport as a `main` concern.

Rules:

- renderer must not derive daemon endpoints or lifecycle policy on its own
- preload may expose the minimum backend config renderer needs to talk to the
  managed local backend
- renderer window/platform composition may construct the typed backend client
  from that preload-provided config before injecting it into feature services
- only `main/transport` owns managed localhost endpoint discovery, token
  issuance, and desktop daemon fetch behavior

This lets transport evolve without forcing feature rewrites.

## IPC Rules

IPC modules should stay thin.

They may:

- register handlers
- receive renderer calls
- forward requests into transport or native helpers

They should not:

- accumulate business orchestration layers by default
- become a second application service tier

If a deeper abstraction is needed later, add it only when complexity proves the need.

## Multi-Window Rule

Windows are shells, not separate products.

Current implementation:

- dashboard and workspace are separate Electron windows
- both currently resolve through one preload entry and one renderer bundle

Preferred growth path:

- window-specific shells under renderer `app/`
- reusable feature domains under renderer `features/`
- separate preload entries only when window capability surfaces differ

That means:

- `renderer/src/app/windows/dashboard` and `renderer/src/app/windows/workspace` remain shell entrypoints
- future reusable product modules should grow under `renderer/src/features/*`
- do not split `dashboard` or `workspace` into separate renderer bundles unless capability boundaries truly diverge

Do not copy feature code per window unless the behavior truly diverges.
Do not split into separate preload entries or renderer bundles just because multiple windows exist; split only when capability boundaries become materially different.

## Current Window Model

The current user-facing shell model is:

- restore a recent workspace when possible
- otherwise open the dashboard launcher
- open the selected workspace in a workspace window
- close the dashboard after launching a workspace

See [Desktop Windows](../architecture/desktop-windows.md) for the current window behavior and lifecycle model.

## Related Docs

- [Desktop Visual Language](./desktop-visual-language.md)
- [Desktop Transport](../architecture/desktop-transport.md)
- [Desktop Windows](../architecture/desktop-windows.md)
- [Logging](./logging.md)
- [Workbench](./workbench.md)

## Review Questions

When reviewing desktop changes, ask:

1. Does this logic belong to Electron, or does it belong to `tuttid`?
2. Is transport knowledge leaking upward into preload or renderer?
3. Is `main` acting as a thin bridge, or is it starting to accumulate business logic?
4. Is a new shared helper truly cross-cutting, or should it stay local to its layer?
5. Would this change make transport or window growth harder later?
6. Is React being used for rendering, DOM events, and subscriptions, or is `useEffect` becoming hidden feature orchestration?
