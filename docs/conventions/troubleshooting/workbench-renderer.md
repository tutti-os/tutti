# Troubleshooting: Workbench And Renderer

[Back to troubleshooting index](./README.md)

### Renderer tile memory warnings from hidden autoplay animation

- Symptom:
  Electron or Chromium logs repeatedly print
  `tile memory limits exceeded, some content may not draw`. DevTools
  performance traces show continuous `FireAnimationFrame`, `Layerize`, and
  `Commit` activity while the visible UI looks mostly idle.
- Quick checks:
  In the trace, group `FunctionCall` or `v8.callFunction` events by `url` and
  `functionName`. Hidden animation players often still appear as repeated
  `requestAnimationFrame` callbacks even when their DOM node has
  `opacity: 0`.
- Root cause:
  CSS-hidden animation elements are still live renderers. An autoplay/looping
  Lottie, canvas, or WebGL player can keep scheduling frames and force layer
  updates across every mounted instance.
- Fix:
  Mount animation players only while the animation is actually visible, and
  defer loading third-party animation runtimes until an active state needs
  them. Do not rely on `opacity`, `visibility`, or off-screen placement to stop
  playback.
- Validation:
  Re-record a short DevTools trace after the fix. Idle UI should no longer show
  the hidden player's function as a high-frequency `requestAnimationFrame`
  source, and Chromium tile memory warnings should stop during idle.

### IME composition breaks fuzzy search or controlled search inputs

- Symptom:
  Chinese, Japanese, or Korean input cannot be committed in a fuzzy search or
  mention picker. Pressing Enter to accept an IME candidate may select a
  highlighted result, submit a search, or clear/replace the partially composed
  text.
- Quick checks:
  Inspect any `keydown` handler that consumes `Enter` or `Tab` while a menu is
  open. Also inspect controlled `input[type="search"]` fields whose `value`
  comes from async search/controller state.
- Root cause:
  IME candidate confirmation is delivered through composition-aware keyboard
  events. If menu shortcuts do not check `isComposing` or the `keyCode/which`
  `229` fallback, the app treats candidate confirmation as a command. If a
  controlled search input pushes every composition update through async search
  state, stale parent values can overwrite the local composing buffer.
- Fix:
  In fuzzy/menu key handlers, return before command handling when
  `event.isComposing`, `event.nativeEvent.isComposing`, `keyCode === 229`, or
  `which === 229`. For controlled search inputs, keep a local value during
  `compositionstart`/`compositionend`, commit to the controller on
  `compositionend`, and ignore stale parent values until the parent catches up.
- Validation:
  Add a unit test for the IME guard or input sync state, then manually type a
  Chinese query and confirm Enter accepts the candidate instead of selecting a
  result or submitting the field.
- References:
  [richTextIme.ts](../../../packages/ui/rich-text/src/editor/richTextIme.ts)
  [useComposedInputValue.ts](../../../packages/ui/react-hooks/src/useComposedInputValue.ts)
  [WorkspaceFileReferencePickerTree.tsx](../../../packages/workspace/file-reference/src/ui/internal/reference/WorkspaceFileReferencePickerTree.tsx)
  [IssueManagerSidebarSections.tsx](../../../packages/workspace/issue-manager/src/ui/internal/shell/IssueManagerSidebarSections.tsx)

### External-store snapshots churn because derived reads lose reference stability

- Symptom:
  `useSyncExternalStore` consumers re-render continuously, lose memoization
  wins, or behave as if external state changed even when the underlying store
  snapshot did not. In a standalone Fusion tool this can appear one step later:
  the loading fallback disappears, then Browser, Agent, or Issue Manager turns
  blank and reports React production error `#185` (maximum update depth).
- Quick checks:
  If the issue starts in a React component or shared React hook, look for a
  direct `useSyncExternalStore` call or an ad hoc subscription wrapper and
  route it through `@tutti-os/ui-react-hooks`.
  If the issue starts in a non-React adapter that exposes `getSnapshot()`,
  check whether it rebuilds objects or arrays on every read instead of reusing
  a derived snapshot while the source snapshot is unchanged.
  Also check whether a Workbench `externalStateSource.getNodeState()` result is
  passed directly as the `useSyncExternalStore` snapshot. That interface may
  intentionally materialize a fresh view object on every read.
- Root cause:
  A subscription boundary reads from a source that returns a fresh derived
  object or array on each `getSnapshot()` call. This can happen either in a
  React subscription wrapper or in the adapter that owns the derived snapshot.
  The type signature allows this, but the runtime contract requires
  referential stability while the source snapshot is unchanged.
- Fix:
  In React consumers and shared frontend packages, prefer
  `@tutti-os/ui-react-hooks` and use `useExternalStoreSnapshot` or
  `useExternalStoreSelector` instead of handwritten `useSyncExternalStore`
  wrappers.
  In adapter-level or non-React derived stores, reuse the derived snapshot
  until the source snapshot reference changes. In
  `@tutti-os/workbench-surface`, prefer
  `packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts` for
  that boundary instead of rebuilding a fresh object inline.
  When the upstream interface is an invalidation source and does not promise
  stable object identity, subscribe through a cached primitive revision and
  read the latest node/workspace state during the resulting render. Do not
  impose a new identity contract on every contribution merely to satisfy one
  React consumer.
- Validation:
  Add or update a regression test that asserts repeated `getSnapshot()` calls
  return the same reference before a real state change, or that the primitive
  revision changes only when the source publishes. Then run the affected
  package tests, `pnpm typecheck`, and the relevant renderer build checks when
  the subscriber is consumed by desktop UI. For Fusion, open representative
  Browser, Agent, and Issue Manager windows and confirm they remain mounted
  after their first non-null external-state update.
- References:
  [packages/ui/react-hooks/src/useExternalStoreSnapshot.ts](../../../packages/ui/react-hooks/src/useExternalStoreSnapshot.ts)
  [packages/ui/react-hooks/src/useExternalStoreSelector.ts](../../../packages/ui/react-hooks/src/useExternalStoreSelector.ts)
  [packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts](../../../packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts)
  [packages/workbench/surface/src/host/missionControlAdapter.ts](../../../packages/workbench/surface/src/host/missionControlAdapter.ts)
  [packages/workbench/surface/src/host/missionControlAdapter.test.ts](../../../packages/workbench/surface/src/host/missionControlAdapter.test.ts)
  [standaloneWorkbenchExternalState.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/standaloneWorkbenchExternalState.ts)
  [StandaloneWorkbenchNodeWindow.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/StandaloneWorkbenchNodeWindow.tsx)

### Workbench host rebuilds when dock business status changes

- Symptom:
  Clicking a dock action such as local agent login opens a browser or starts a
  backend command, but the expected terminal or agent node disappears, is not
  created, or loses context. The UI can look like the action ran in the
  background while the Workbench session was rebuilt underneath it.
- Quick checks:
  Search the workspace shell for `useSyncExternalStore` subscriptions,
  revision values, or React state that feed `createHostInput(...)`.
  If provider status, quota, sync, installation, or authentication state is in
  that dependency list, inspect whether status changes are recreating
  `WorkbenchHost` props, node definitions, or contribution objects.
  Also check whether `dockEntries` include live business fields that change on
  every status refresh.
- Root cause:
  High-churn business status was modeled as host input state instead of dock
  presentation state. Each status revision rebuilt the Workbench host input and
  could tear down or replace the active host/session while an action still
  needed the old host handle.
- Fix:
  Keep `dockEntries` and Workbench host input stable for static workspace
  wiring. Route live dock presentation through
  `WorkbenchHostDockEntryStateSource` or an equivalent service-backed getter
  plus subscription. The dynamic source may expose disabled/loading state,
  badges, hover actions, attention tokens, and temporary visibility, but it
  should not own node definitions or launch wiring. Dock action callbacks
  should receive the current `WorkbenchHostHandle` from the dock interaction
  instead of reading a host from stale outer React state.
- Validation:
  Add a regression test for the dynamic state source that proves one source
  object reads updated service snapshots without recreating host input.
  Then run desktop typecheck and relevant tests. For runtime verification,
  start the desktop or web renderer, trigger a login/install dock action, and
  confirm the terminal or agent node remains stable while dock status updates.
- References:
  [docs/architecture/workbench-dock-model.md](../../architecture/workbench-dock-model.md)
  [packages/workbench/surface/src/host/types.ts](../../../packages/workbench/surface/src/host/types.ts)
  [packages/workbench/surface/src/host/WorkbenchHostDock.tsx](../../../packages/workbench/surface/src/host/WorkbenchHostDock.tsx)
  [workspaceAgentProviderDockStateSource.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceAgentProviderDockStateSource.ts)
  [useWorkspaceWorkbenchShellRuntime.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/useWorkspaceWorkbenchShellRuntime.tsx)

### Fusion launcher rail diverges from the Workspace Dock

- Symptom:
  Fusion Mode shows different icons or ordering than the Workspace Workbench
  Dock, omits an installed Workspace App, loses a dynamic disabled/loading
  state, or focuses an App Center or file-preview window when a different exact
  launcher was selected. The floating Dock may also regress into a permanent
  window/task management panel instead of its narrow launcher rail. A visual
  variant shows intrinsic-size images filling most of the rail, oversized icon
  squircles that look like cards, or two rounded outlines around the entire
  floating Dock. After a renderer-only hot reload, the rail may instead become
  narrow and left-aligned while the outer panel remains at its old width.
- Quick checks:
  Confirm both presentation modes call
  `resolveWorkspaceDockLauncherCatalog(...)` over the same host contributions
  and explicit Dock entries. In Fusion, verify
  `WorkspaceAppCenterIntegration` is mounted before resolving installed-app
  retention and that the host `dockStateSource` is subscribed. Search for a
  hardcoded Fusion primary-kind array, duplicated icon table, fake
  `WorkbenchNode`, or family-level matching that ignores Workspace App `appId`
  and workspace identity. For visual drift, inspect whether the rail owns
  `desktop-dock--fixed-metrics`, whether the transparent Fusion `BrowserWindow`
  enables a native shadow in addition to renderer elevation, and whether the
  Fusion Dock route resets the shared `body` minimum width and background. If
  the rail and panel disagree, compare the live native bounds with the shared
  collapsed-window, panel, and rail dimensions.
- Root cause:
  A separate Fusion launcher list duplicates product policy already owned by
  the Workspace Dock catalog. It cannot stay aligned with contribution order,
  retention, installed apps, launch payloads, dynamic states, or icons. Using
  whole Workbench nodes merely to render Dock items creates the opposite
  ownership leak, while matching only by broad kind folds exact Workspace Apps,
  App Center, file previews, or cross-workspace resources together.
  Separately, Workbench Dock child classes depend on metrics normally inherited
  from `desktop-dock-plate`; reusing the children without a metrics owner makes
  their custom-property dimensions invalid. A native shadow around an inset
  renderer panel produces a second full-window outline. Even with that shadow
  disabled, the UI System's normal opaque `body` canvas and `320px` minimum
  width form another outer shell inside the `88px` transparent window and
  clip the inset panel's right edge. Renderer hot reload updates the rail but
  does not recreate an existing Electron `BrowserWindow`, so stale `124px`
  bounds can surround a new `70px` rail and leave one side visibly empty.
- Fix:
  Keep catalog merge, retention, and ordering in the shared pure launcher seam.
  Let both surfaces consume its `WorkbenchHostDockEntry` results. Fusion should
  reuse each entry's icon, section, order, visibility, state, badge, launch
  payload, and `newWindowLaunchPayload`, then add only desktop-native window and
  background-resource projection. Mount the existing App Center integration,
  preserve exact `(workspaceId, kind, resourceId)` identity, and render normal
  state as the narrow rail. Window and background-task rows belong only to the
  shortcut-expanded search surface. Reuse
  `desktop-dock--fixed-metrics` for the canonical icon geometry, preserve
  borders that are part of the icon asset itself, and let the renderer own the
  floating panel border/elevation with native `BrowserWindow` shadow disabled.
  Mark the Fusion Dock renderer root and reset only that route's `body` to
  `min-width: 0` and a transparent background; do not weaken the shared canvas
  defaults used by normal product windows. Keep the collapsed native window at
  `88px`; after the `8px` transparent inset and one-pixel panel border, use a
  `70px` launcher rail and remove the Workbench-only left indicator gutter so
  the canonical `43.2px` icons remain visually centered. Apply that gutter
  override directly on the Fusion rail element; a layered utility can lose to
  the later shared metrics declaration and leave the icon column shifted by
  half the gutter. Constrain the renderer surface itself to `72px` while
  collapsed, and reconcile any reused native Dock to the current collapsed or
  search width before showing it.
- Validation:
  Compare the same workspace in Workspace Workbench and Fusion Mode. Verify
  launcher order, separators, icons, installed Workspace Apps, dynamic states,
  and transient `when-open` entries match. Open two apps and a file preview;
  counts and activation must stay on their exact entries. Hide and show the
  floating Dock without using the shortcut and confirm no permanent
  window/task list appears; the shortcut should temporarily expand search.
  Restart the desktop after changing `BrowserWindow` shadow options, then
  confirm icons remain `43.2px`, both panel edges retain their rounded corners,
  the transparent inset exposes the desktop, and the floating surface has one
  outer outline.
  Run the focused launcher-catalog, Fusion launcher-model, Workbench surface,
  desktop renderer-boundary, and i18n checks.
- References:
  [workspaceDockLauncherCatalog.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceDockLauncherCatalog.ts)
  [fusionDockLauncherModel.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/fusionDockLauncherModel.ts)
  [FusionLauncherRail.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/FusionLauncherRail.tsx)
  [WorkbenchHostDock.tsx](../../../packages/workbench/surface/src/host/WorkbenchHostDock.tsx)

### Effect replay strands async work behind lifecycle or one-shot refs

- Symptom:
  A React component works far enough to start async work, but later promise
  continuations silently skip state updates behind an `isMountedRef.current`
  guard. In development, the UI can remain permanently stuck in a loading
  state even though the backend request succeeded. A related Fusion failure
  leaves a standalone native window permanently on **Loading Fusion window**:
  the first StrictMode setup marks a `launchStartedRef`, its cleanup retires
  the async result, and the replayed setup refuses to launch because the ref is
  already true.
- Quick checks:
  Search the component for an effect cleanup that sets an `isMountedRef` or
  similar lifecycle ref to `false`. If the effect body returns the cleanup
  directly, verify the setup path also sets the ref back to `true`. Also search
  for component-lifetime `started`, `initialized`, or one-shot refs used to
  suppress an async effect. Reproduce the exact development
  setup -> cleanup -> setup sequence and check whether the first cleanup owns
  the only request while the second setup is gated out.
- Root cause:
  React development and StrictMode can run an effect cleanup followed by setup
  while the component continues to be used for validation. If setup does not
  restore the mounted ref, later async callbacks treat the live component as
  unmounted and drop state updates. A lifetime one-shot flag creates the mirror
  failure: cleanup invalidates the first callback, while the flag prevents the
  live replay from either adopting the in-flight request or starting a new one.
- Fix:
  Use an effect body that sets the mounted ref to `true` before returning the
  cleanup that sets it to `false`. For a resource-creating one-shot launch, use
  a request/generation controller instead of a bare lifetime ref: defer the
  initial execution by one microtask so an abandoned StrictMode setup can
  retire before creating a resource, let the replayed setup adopt an already
  in-flight request, and allow only the current generation to publish the
  result. Do not create duplicate terminals, browsers, or app runtimes merely
  to make the second setup succeed.
- Validation:
  Add a deterministic setup -> cleanup -> setup test that ends in the ready
  state and asserts the backing resource is created once. Also cover cleanup
  after a request is already in flight so only the current setup may publish.
  Run the affected React package tests and cold-start the consuming desktop UI,
  because hot reload can preserve the stale ref value from before the fix. For
  Fusion, open representative Browser, Files, Terminal, App Center, and Issue
  Manager windows and confirm none retain the loading fallback.
- References:
  [useAgentGUINodeController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)
  [StandaloneWorkbenchNodeWindow.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/StandaloneWorkbenchNodeWindow.tsx)
  [standaloneWorkbenchNodeLaunchRequest.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/standaloneWorkbenchNodeLaunchRequest.ts)

### Workbench node body warns about updating WorkbenchNodeLayer during render

- Symptom:
  Opening a workbench node shows React's warning that
  `WorkbenchNodeLayer` is updated while rendering a different node body
  component. The node may stay on a loading surface even though the backing
  request succeeds.
- Quick checks:
  Inspect controller construction paths called from React render or `useMemo`.
  If the constructor calls `setActiveFile`, subscribes with an immediate
  callback, publishes node runtime state, or calls any host setter, it can
  synchronously update the workbench layer during render. Also inspect effect
  cleanups that call `controller.dispose()`: React StrictMode can run an
  immediate cleanup/setup cycle in development, so disposing the same retained
  controller during that validation pass can make later async responses look
  stale forever.
- Root cause:
  Workbench node bodies can create controllers while rendering. Any synchronous
  controller side effect that calls `context.setNodeRuntimeState`,
  `context.setSnapshotNodeState`, or a React state setter escapes into the
  parent layer before React has finished rendering the body.
- Fix:
  Keep controller construction side-effect free. Start active-file work,
  subscribe snapshots, and perform the initial snapshot sync from `useEffect`.
  If a subscriber must receive the current snapshot immediately, subscribe and
  then invoke the listener from the effect body. Dispose retained controllers
  with a StrictMode-safe delayed cleanup that can be canceled if the same
  controller is set up again immediately.
- Validation:
  Verify construction does not call host state publishers, then run the
  affected desktop tests and open the node in development with DevTools visible.
- References:
  [workspaceFilePreviewNodeController.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceFilePreviewNodeController.ts)
  [WorkspaceFilePreviewNodeBody.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceFilePreviewNodeBody.tsx)

### Renderer component repeatedly re-renders without visible changes

- Symptom:
  The desktop renderer feels stuck, text flickers, or React reports
  `Maximum update depth exceeded`, but the current stack only points at the
  component that called `setState`.
- Quick checks:
  First inspect state-sync diagnostics. Enable the renderer-wide React Profiler
  only when its render-storm diagnostics are needed by launching with
  `VITE_TUTTI_REACT_PROFILER=1`; leave it off for Chrome Performance captures
  on large workspaces because React dev component tracks can make trace
  initialization stall. For prop identity churn, why-did-you-render is enabled
  by default when launching with `make dev-gui`. Disable that default with
  `VITE_TUTTI_WHY_DID_YOU_RENDER=0 make dev-gui`, or set
  `localStorage.tuttiWhyDidYouRender = "0"` in DevTools and reload the renderer.
  For other development entrypoints, enable it by setting
  `localStorage.tuttiWhyDidYouRender = "1"` and reloading the renderer.
- Root cause:
  React StrictMode can intentionally replay setup/cleanup in development, but a
  continuously increasing render count usually means a parent is passing a new
  object/function every render or an effect writes state from a dependency that
  changes on every render.
- Fix:
  Stabilize the value at the ownership boundary, or remove derived presentation
  values from bidirectional state. For external/workbench state, only sync
  canonical identifiers and derive display text from the owning service.
- Validation:
  With why-did-you-render enabled, reproduce once and confirm the noisy
  component lists the expected prop or hook difference. Then disable the tool
  and run the affected renderer tests plus desktop typecheck.
- References:
  [main.tsx](../../../apps/desktop/src/renderer/src/main.tsx)
  [whyDidYouRender.ts](../../../apps/desktop/src/renderer/src/lib/whyDidYouRender.ts)
