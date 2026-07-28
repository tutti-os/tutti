# Mobile Agent DI Data Layer

Status: implemented; physical-device visual review pending

## Goal

Move the Mobile Agent MVP's account, device, workspace, session, message, and
composer behavior out of React screens. Keep Agent Activity semantics aligned
with Desktop while allowing Native-specific presentation and interaction.

The first conversation rail alignment is now implemented on top of the same
section membership and canonical summary semantics as Agent GUI.

The first conversation-flow alignment now consumes the same canonical
AgentGUI transcript projection. Mobile keeps its Native renderer, scroll
follow behavior, and local disclosure state, while AgentGUI owns message
merging, thinking, tool activity, processing, notices, and turn summaries.

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
      ├─ WorkspaceConversationRailService
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

- `WorkspaceConversationRailService` owns section queries, pagination, polling,
  cursors, totals, and project labels. It uses the server's exact
  `railSectionKey` membership and never infers projects from `cwd`.
- Rail Session DTOs and message pages are mapped into canonical activity
  entities and dispatched into one workspace `AgentSessionEngine`. The Rail
  snapshot retains only membership, ordered ids, cursors, totals, and request
  state; Session DTOs are transient input rather than a second entity cache.
- Mobile consumes the DOM-free
  `@tutti-os/agent-gui/conversation-rail-projection` entry for the same title,
  provider, status, attention, pin, and sort semantics as Agent GUI, then
  renders a Native-specific drawer. Its local disclosure state may collapse a
  section, while loading/error/retry state comes from the Rail service rather
  than from a second list cache.
- Mobile consumes the DOM-free
  `@tutti-os/agent-gui/conversation-projection` entry for the selected
  Session's canonical conversation VM. Pending Interactions stay Engine facts;
  the Native renderer does not infer actionability from a transcript row.
- Mobile consumes the DOM-free
  `@tutti-os/agent-gui/composer-projection` entry for Composer support and
  presented settings. Composer options load through the exact Agent Target's
  Engine command; the shared activity-tuttid adapter maps the daemon response
  once. Existing sessions update settings through the Engine, while a new
  session retains target-scoped draft settings in `ComposerDraftService` and
  carries them on its activation intent.
- Create, send, stop, pin, delete, and Interaction response enter the Engine as
  intents. The Mobile command port performs generated-client calls and returns
  mapped command results to the Engine. Rename uses the generated client, then
  immediately upserts the returned canonical Session and reconciles Rail
  membership.
- A workspace-scoped DeviceLink `agent_live` stream is the foreground update
  lane. Its Go Subscriber validates revision, identity, epoch, and sequence
  continuity before Mobile applies `message_delta` through the activity-core
  optimistic overlay or schedules canonical reconciliation.
- Mobile keeps that lane in a dedicated service and Android executor rather
  than mixing its retry/overlay lifecycle into workspace orchestration or
  consuming a general DeviceLink request worker. The Mobile Android host owns
  the composite DeviceLink plus Agent Subscriber AAR assembly.
- Session polling remains single-flight at two seconds and selected-session
  message polling remains single-flight at one second only while the live lane
  is disconnected. `stream_ready` disables both pollers; disconnect restores
  them while Mobile retries the long stream.
- Initial messages use the Desktop-aligned newest 100 descending page and the
  server `hasMore` boundary. Incremental reads use `afterVersion`; older history
  uses `beforeVersion`.
- Active conversation identity is owned by
  `WorkspaceNavigationService`. Per-session/new-session drafts are process-only
  data owned by `ComposerDraftService`.
- Services expose structured error codes. Native views map those codes through
  Mobile i18n.

## Native UI foundation

- The Mobile UI is a Native renderer for the same canonical data, not a DOM
  implementation of existing Desktop components.
- `@tutti-os/ui-system` remains the semantic-token and component-contract
  owner. Its experimental Native entry owns reusable React Native primitives; Mobile
  owns screen composition and platform-specific interaction.
- `src/tokens/renderer-theme.json` is the single semantic manifest for the
  shared Web/Native token subset. It generates Web CSS renderer variables and
  Native light/dark palettes, while allowing renderer-specific literal values
  where their visual language or color syntax differs. `MobileUIProviders`
  resolves the operating-system scheme and composition consumes
  `useNativeTheme()`. Full cross-renderer visual-token parity remains deferred
  work.
- The bootstrap spike establishes NativeWind 4/Tailwind 3, the Gesture Handler
  root, Reanimated Worklets, a Bottom Sheet modal provider, and an RN Primitives
  portal host. The first experimental Native Button, IconButton, ListRow, and
  Sheet primitives are now promoted into the UI System.
- React Native Reusables is the source-copy starting point for primitives. A
  component is adapted and promoted into the UI System Native layer before an
  app imports it. `@gorhom/bottom-sheet` remains a dependency for complex
  sheets and is wrapped only once it is a reusable product pattern.
- Native primitives use the Mobile development gallery as their target-renderer
  preview surface; the DOM storyboard cannot provide valid visual evidence for
  React Native components.

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

- Search and project-level Rail actions.
- Agent GUI-equivalent optimistic Rail rows before a newly created Session is
  confirmed by the canonical section read.
- Physical-device visual and accessibility review of the Native Rail.
- Device/workspace/session navigation preference persistence after a generic
  Mobile preference port exists.
- Relay fallback and direct/Relay live-stream handoff.
- Richer ambiguous-delivery diagnostics beyond the current reconcile-first,
  exact-identity Retry state.
- Remaining rich conversation parity after Markdown/code, canonical prompt
  actions, media attachments, processing, and basic tool grouping: richer tool
  detail presentation plus host capabilities for file/app/issue links.
