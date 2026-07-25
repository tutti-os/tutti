# Mobile Agent DI Data Layer

Status: implemented; follow-up visual review pending

## Goal

Move the Mobile Agent MVP's account, device, workspace, session, message, and
composer behavior out of React screens. Keep Agent Activity semantics aligned
with Desktop while allowing Native-specific presentation and interaction.

The conversation rail visual redesign is intentionally deferred.

## Confirmed boundaries

- Desktop and Mobile are sibling applications. Neither imports source from the
  other application.
- Shared canonical session state, reducers, selectors, and command semantics
  live in `@tutti-os/agent-activity-core`.
- Generated tuttid DTO-to-activity mapping lives in the narrow
  `@tutti-os/agent-activity-tuttid-adapter` package and is consumed by both
  applications.
- Application DI wrappers own account state, DeviceLink, transport creation,
  logging, navigation preferences, polling/event wiring, and lifecycle.
- Mobile `services/**` are `.ts` files and do not import React or hooks.
- React binding components use `useSyncExternalStore`. They do not copy service
  snapshots into page state.
- `useEffect` remains allowed only for presentation effects such as focus,
  keyboard, scroll, animation, layout, and resetting component-local input.

## Scope model

```text
Bootstrap container
├─ Unauthenticated child
│  └─ LoginService
└─ Authenticated child (mutually exclusive with Unauthenticated)
   ├─ immutable AccountSession
   ├─ DeviceService
   ├─ one DeviceLink-backed TuttidClient
   ├─ AgentDirectoryService
   ├─ WorkspaceCatalogService
   └─ one active Workspace child
      ├─ WorkspaceActivityService + one AgentSessionEngine
      ├─ WorkspaceNavigationService
      └─ ComposerDraftService
```

Only one authenticated account, connected device, and active workspace are
retained. Account changes replace the complete authenticated subtree. Workspace
changes dispose the old child before initializing and publishing the candidate.
Sibling application scopes stay isolated; reusable implementation belongs in a
package rather than a cross-application import.

Mobile keeps dynamic account, DeviceLink, and workspace inputs explicit in its
composition root, registers the resulting services in the matching child
container, and lets that container be their sole disposal owner. This preserves
the Canvas-style child-scope lifetime and sibling isolation without requiring
React bindings or decorator syntax in service modules.

## Data and command flow

- Workspace session snapshots and message pages are mapped into canonical
  activity entities and dispatched into one workspace `AgentSessionEngine`.
- Create, send, stop, and Interaction response enter the Engine as intents.
  The Mobile command port performs generated-client calls and returns mapped
  command results to the Engine.
- Session polling is single-flight at two seconds. Selected-session message
  polling is single-flight at one second until the DeviceLink event lane is
  available.
- Initial messages use the Desktop-aligned newest 100 descending page and the
  server `hasMore` boundary. Incremental reads use `afterVersion`; older history
  uses `beforeVersion`.
- Active conversation identity is owned by
  `WorkspaceNavigationService`. Per-session/new-session drafts are process-only
  data owned by `ComposerDraftService`.
- Services expose structured error codes. Native views map those codes through
  Mobile i18n.

## Lifecycle

- Backgrounding immediately pauses pairing work, polling, commands, and runtime
  availability.
- The active workspace child and DeviceLink are retained for a 15-second grace
  window.
- Foregrounding inside the window resumes and requests authoritative
  reconciliation.
- Expiry disposes the workspace child, closes DeviceLink, and returns to device
  selection.

## Validation

- Mobile TypeScript typecheck and Jest suite.
- Shared adapter and Desktop TypeScript typechecks.
- Container transition and background-grace tests.
- Navigation/draft ownership tests.
- Lightweight `useSyncExternalStore` binding test.
- Final changed-aware repository validation.

## Deferred follow-ups

- Conversation rail presentation alignment and shared no-DOM rail projection.
- Device/workspace/session navigation preference persistence after a generic
  Mobile preference port exists.
- DeviceLink event stream and Relay fallback.
- Richer ambiguous-delivery diagnostics beyond the current reconcile-first,
  exact-identity Retry state.
- Rich conversation renderer parity (Markdown/code, complete tool grouping,
  processing, and unsupported fallback).
