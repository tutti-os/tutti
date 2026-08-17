# Troubleshooting: Workbench And Renderer

[Back to troubleshooting index](./README.md)

### Renderer Vite cannot resolve a workspace package subpath

- Symptom:
  The Electron development overlay reports
  `[plugin:vite:import-analysis] Failed to resolve import` for a public
  workspace package subpath, while Node can import that same subpath and its
  package `exports` entry exists.
- Quick checks:
  Inspect `apps/desktop/electron.vite.config.ts` for a source alias on the
  package root, then compare its explicit child aliases with the import that
  failed. A string root alias also matches subpath prefixes, so Vite may rewrite
  `@scope/package/feature` as `src/index.ts/feature` before package exports can
  resolve it.
- Root cause:
  The public child entry is missing from a consumer alias map that already
  redirects the package root to a source file.
- Fix:
  Add the public child entry to the Electron Vite alias map before the
  package-root alias and add the matching source path to
  `apps/desktop/tsconfig.json`. Keep the package's `exports` and
  `publishConfig.exports` declarations aligned; do not bypass the public
  subpath with a consumer-relative source import.
- Validation:
  Run the desktop renderer build, which exercises Vite import analysis for
  every entry, including secondary windows such as screenshot capture.

### Tabbed standalone Browser remains blank with a cold lifecycle

- Symptom:
  A standalone Browser shows its default URL and tab title, but the guest area
  stays blank after multi-tab support is enabled. Renderer diagnostics keep the
  active tab in the internal `cold` lifecycle even though activation was
  requested. The same Browser may work in an OS-mode Workbench window.
- Quick checks:
  Compare the surface node ID with the node ID in Browser runtime events. A
  tabbed surface owns a parent such as `browser:surface` while its controller
  and guest emit events for child IDs such as `browser:surface:tab:1`.
- Root cause:
  A host event adapter still accepts only exact parent-node matches. Activation
  succeeds for the child guest, but its returned `active` event is discarded,
  leaving the renderer runtime at its default cold lifecycle. The address bar
  can still show the configured default URL, which makes this look like a
  webview loading failure rather than an event-scope mismatch.
- Fix:
  Use the Browser Node package-owned surface-event predicate. It accepts the
  exact parent ID and the parent's `:tab:*` children while rejecting sibling
  Browser surfaces. Do not restore a second manual activation path or duplicate
  the child-ID convention in the host.
- Validation:
  Cover parent and child state events, sibling rejection, and `open-url` events
  whose ownership comes from `sourceNodeId`. Then run Browser Node tests and the
  host's focused Browser lifecycle test.
- References:
  [eventScope.ts](../../../packages/browser/workbench-node/src/core/eventScope.ts)
  [standaloneAgentToolWorkbench.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/standaloneAgentToolWorkbench.ts)
  [browser-node-package.md](../../architecture/browser-node-package.md)

### Final Browser tab close leaves the Workbench window open

- Symptom:
  A Browser Workbench node has one tab. Its tab close control is visible, but
  clicking it leaves the Browser window open. The native Workbench close
  control may still work.
- Quick checks:
  Inspect the callbacks passed to `BrowserNodeWorkbenchHeader`. Confirm that
  the final-tab callback reaches `windowActions.close()` and is not implemented
  as `BrowserNodeHostApi.close({ nodeId: surfaceNodeId })`. The Workbench node ID
  is a parent surface ID; registered Browser guests use `:tab:*` child IDs.
- Root cause:
  Browser guest cleanup and Workbench surface closure are different lifecycle
  boundaries. Closing a parent ID through the Browser host API emits a guest
  close event but cannot remove the Workbench node. The native window control
  can mask this mismatch because its own click handler separately closes the
  Workbench window, while the final-tab control has no such fallback.
- Fix:
  Keep the native action and final-tab request separate. Bind the dedicated
  final-tab request to `windowActions.close()` and let Browser tab-surface lease
  release close the remaining child guests after unmount. Do not add a second
  Workbench close call to the native control's capture path.
- Validation:
  Exercise the Browser Workbench close-request adapter and assert that its
  final-tab request runs the Workbench close action exactly once. Keep the
  package tab intent tests to prove that the dedicated Workbench request wins
  while the ordinary standalone-host callback remains a supported fallback.
- References:
  [BrowserNodeChrome.tsx](../../../packages/browser/workbench-node/src/react/BrowserNodeChrome.tsx)
  [Browser Workbench adapter](../../../packages/browser/workbench-node/src/workbench/index.ts)
  [Browser Workbench adapter test](../../../packages/browser/workbench-node/src/workbench/browserNodeCloseRequests.test.ts)

### Inline custom-header menu is clipped to the Workbench title bar

- Symptom:
  A shared header menu works in a standalone surface but appears empty, only a
  few pixels tall, or completely hidden when the same header renders inside an
  OS-mode Workbench window. Dialogs opened from the menu may be unreachable
  because the menu item that opens them is clipped.
- Quick checks:
  Confirm both shells render the same menu component, then inspect ancestor
  boxes between the trigger and the Workbench node body. In particular, check
  `.workbench-window__header--custom`, whose default `overflow: hidden` keeps
  ordinary custom-header content inside the title-bar row.
- Root cause:
  An inline menu extends below the custom-header row, but the Workbench row
  clips descendants before stacking order can place the menu over the node
  body. Raising the menu z-index cannot escape ancestor overflow clipping.
- Fix:
  Keep the shared inline menu and declare the owning node's header presentation
  as `window.header: { overflow: "visible" }` (plus its explicit `heightPx`
  when it owns a non-default header height). Workbench projects that contract
  to `data-window-header-overflow="visible"` on `.workbench-window` and allows
  overflow only for that custom-header row. Do not copy the menu into the OS
  shell or globally disable clipping for every custom header. The outer
  `.workbench-window` remains the window-bounds clip.
- Validation:
  Run the Browser Node and Workbench Surface package tests, typecheck the
  affected packages, and build the desktop renderer. In both Agent-only and OS
  modes, open the Browser three-dot menu and verify the same nested actions and
  Browser settings dialog are usable above the guest webview.
- References:
  [BrowserNodeChrome.tsx](../../../packages/browser/workbench-node/src/react/BrowserNodeChrome.tsx)
  [workbench.css](../../../packages/workbench/surface/src/styles/workbench.css)
  [browser-node-package.md](../../architecture/browser-node-package.md)

### Overflowing custom header widens the Workbench body

- Symptom:
  A resizable Workbench node remains visually inside its frame, but after a
  custom header gains enough non-wrapping content, its body and embedded
  webview retain a much wider layout viewport. Narrowing the node clips the
  page instead of triggering its responsive layout.
- Quick checks:
  Compare the bounding widths of `.workbench-window`,
  `.workbench-window__header--custom`, and `.workbench-window__body`, then
  inspect the computed Grid columns. If the outer window keeps its saved width
  while the implicit column, header, and body all resolve wider, trace the
  header's min-content contribution rather than changing the webview width.
- Root cause:
  A Grid that defines only rows leaves its single implicit column sized as
  `auto`. A custom header with `overflow: visible` retains a content-based
  automatic minimum, so non-wrapping tabs or controls can enlarge that column.
  The body shares the enlarged track, and a `width: 100%` webview then receives
  the wrong layout viewport even though the outer window clips the result.
- Fix:
  Define the Workbench window's single column as `minmax(0, 1fr)`. Keep the
  header's intentional visible overflow for inline overlays; the explicit
  zero-minimum track prevents horizontal min-content from resizing the shared
  body column. Adding `min-width: 0` only inside the custom header does not
  change the Grid item's automatic minimum contribution.
- Validation:
  Open enough fixed-minimum-width tabs to overflow a Browser node, then resize
  the node narrower and wider. Confirm the tab list scrolls, the header and
  body widths remain equal to the Workbench frame, and the guest page responds
  to each available width instead of being clipped at its previous viewport.
- References:
  [workbench.css](../../../packages/workbench/surface/src/styles/workbench.css)
  [BrowserNodeChrome.tsx](../../../packages/browser/workbench-node/src/react/BrowserNodeChrome.tsx)

### Standalone Agent dev window stays black during cold startup

- Symptom:
  A local development launch creates the standalone Agent native window, but
  only the window chrome is visible for several seconds before the Agent header,
  rail, conversation, and composer appear. A related failure leaves the window
  black permanently because the renderer root throws before AgentGUI mounts.
- Quick checks:
  Check `tutti-desktop.log` for `react.uncaught` before profiling cold startup.
  If the error is `agent_gui_workbench.invalid_provider`, compare the encoded
  Agent window intent with the standalone route's launch-provider resolution.
  A primary standalone Agent startup may legitimately omit both provider and
  Agent Target metadata while the directory is still loading.
  Compare desktop-ready, first renderer diagnostic, standalone route mount,
  AgentGUI body mount, and composer-ready timestamps. Time the daemon workspace,
  session-list, rail, target, and provider-status endpoints independently. If
  normal workspace/session calls finish in milliseconds while the first
  renderer diagnostics arrive seconds later, the delay is in renderer module
  transformation/evaluation rather than SQLite or workspace hydration. Also
  time provider statuses per provider; one slow CLI probe can dominate a serial
  all-provider scan.
  For provider-status startup, correlate the same `session_id` across
  `tutti-desktop.log` and `tuttid.log`. Renderer events
  `agent_provider_status.request.started`, `.resolved`, `.failed`,
  `.cache_hit`, and `.reused` show request scope, provider IDs, request ID, and
  total elapsed time. Daemon event
  `tutti.agent_provider.status_list.completed` shows the batch total; per-provider
  `tutti.agent_provider.status_detection.completed` events split runtime
  resolution, adapter probe, auth, CLI version, and post-check time. Concurrent
  step times overlap, so compare the largest step with the provider total rather
  than summing every step.
- Root cause:
  For the permanent-black variant, an optional startup provider can be passed
  directly to the strict workbench provider normalizer. The generic primary
  Agent window starts with workspace identity only, so normalizing that absent
  value throws during React render even while the daemon and provider probes
  remain healthy.
  Development Vite transforms source modules on demand. An Agent-only route can
  therefore remain on a black Suspense fallback while nested lazy boundaries
  discover large dependency graphs. In the desktop renderer, enabling Babel
  React Compiler during `serve` makes every cold TSX request substantially more
  expensive; a body import that reaches hundreds of TSX modules can spend
  several seconds compiling even though all source files are local. A warm
  request completing quickly distinguishes this from disk or loopback HTTP
  throughput. Static imports for Browser, Terminal, File
  Manager, App Center, Message Center, settings/import panels, or account UI
  enlarge the shell graph even when those surfaces are closed. Starting
  Workspace App polling at mount can also prepare every app runtime during the
  same cold compile. Separately, a single global in-flight provider-status
  promise makes the active provider wait behind a slow all-provider scan.
- Fix:
  Resolve the absent startup provider to the existing workbench default at the
  standalone route boundary, then use the strict normalizer only for a supplied
  provider. Keep malformed non-empty values as errors, and keep Agent Target
  directory resolution authoritative once it loads.
  Keep workspace and standalone Agent routes separate. Let both already-lazy
  routes statically own the full AgentGUI body so neither adds a second import
  waterfall beneath its route fallback. Render
  the same structured shell at the route Suspense, workspace hydration,
  host-session binding, and AgentGUI-body boundaries; a plain background at any
  one of those boundaries brings the apparent black screen back. Keep the
  reusable body shell in the narrow `@tutti-os/agent-gui/startup-shell` entry;
  let desktop compose standalone window chrome around it. Keep React Compiler
  settings aligned between development and production; do not hide a cold
  transform bottleneck by changing compiler semantics only in development.
  Reduce the initial module graph, precompile a stable package boundary, or
  schedule non-blocking preload work instead. For desktop development, wait for
  Vite to transform the statically reachable startup graphs before
  `electron-vite` launches Electron. Treat the top-level workspace and
  standalone Agent lazy route modules as explicit warmup entries; do not follow
  every dynamic import, because that compiles unopened tools and diagnostics.
  Keep the
  right side shaped like the empty-home/new-conversation hero, not a selected
  conversation timeline with a bottom dock. Keep the fallback hero composer
  non-interactive until the real controller owns its draft.
  Load tool bodies on first open, show a panel-local busy state while they load,
  defer non-critical panel hosts until after the first frame, and start
  Workspace App polling only for an explicit Apps/app open. Key provider-status
  requests by request scope, prioritize the selected provider, merge responses
  per provider, and ignore stale results for a provider already refreshed by a
  newer request.
- Validation:
  Keep a focused regression test for an Agent window intent with no provider;
  it must reach the startup shell without weakening extension-provider
  validation.
  Run focused provider concurrency and standalone tool-lifecycle tests, desktop
  typecheck, renderer boundary checks, and a production desktop build. Inspect
  the generated chunks to confirm the standalone shell does not statically
  import the full AgentGUI body and that heavy optional App Center, Message
  Center, settings, import, and account presentation modules stay in separate
  async chunks. Keep a source-level regression test that verifies every
  pre-controller return path renders the structured startup shell and every
  deferred tool body has a non-empty loading fallback.
  Finally cold-start local dev and compare the same timestamp landmarks; this
  manual renderer verification requires explicit user approval. If the dynamic
  import still dominates, compare cold and warm module-graph timings before
  investigating daemon hydration or provider discovery. The dev server must log
  `renderer warmup completed` before `start electron app`.
  When a provider-status request is slow, compare Renderer `durationMs` with the
  daemon batch `durationMs`. A large daemon total points to provider detection;
  a large Renderer-only gap points to transport, timeout handling, or Renderer
  runtime-probe fallback. Within the daemon, compare each provider total and its
  largest phase. Logs intentionally record provider IDs, counts, outcomes, and
  durations, but not executable paths, command output, environment values, or
  error messages.
- References:
  [agent-gui-node.md](../../architecture/agent-gui-node.md)
  [WorkspaceWindow.tsx](../../../apps/desktop/src/renderer/src/app/windows/workspace/WorkspaceWindow.tsx)
  [electron.vite.config.ts](../../../apps/desktop/electron.vite.config.ts)
  [renderer-dev-warmup.mjs](../../../tools/scripts/renderer-dev-warmup.mjs)
  [StandaloneAgentToolSidebar.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/StandaloneAgentToolSidebar.tsx)
  [desktopAgentProviderStatusService.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts)
  [desktopAgentProviderStatusDiagnostics.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusDiagnostics.ts)
  [service.go](../../../services/tuttid/service/agentstatus/service.go)
  [service_status.go](../../../services/tuttid/service/agentstatus/service_status.go)

### Renderer body requests fail with `ERR_H2_OR_QUIC_REQUIRED`

- Symptom:
  Renderer `POST` or `PUT` calls to the local daemon fail with
  `net::ERR_H2_OR_QUIC_REQUIRED`, while nearby `GET` calls still succeed. Agent
  provider options or model lists may remain loading, and Workbench or tracking
  writes can fail at the same time.
- Quick checks:
  In DevTools, compare a failed body-bearing request with a successful `GET` to
  the same current daemon origin. Confirm the daemon listener port and bearer
  token have rotated correctly before treating this as stale endpoint recovery.
- Root cause:
  Rebuilding a request with `new Request(rewrittenUrl, originalRequest)` carries
  the original body forward as a `ReadableStream`. Chromium treats that as a
  streaming upload and requires HTTP/2 or QUIC, but the managed loopback daemon
  serves HTTP/1.1.
- Fix:
  Materialize the already-serialized request body before rebuilding the request,
  then explicitly preserve method, headers, cancellation signal, and other
  request metadata. Continue resolving the current daemon origin and bearer
  token for every request.
- Validation:
  Exercise an actual body-bearing daemon call from Chromium, not only Node's
  fetch implementation, and confirm it returns a normal HTTP response. Keep
  unit coverage for JSON and binary bytes, custom headers, query parameters,
  cancellation, and rotating endpoint/auth configuration.
- References:
  [createRestartAwareFetch.ts](../../../apps/desktop/src/renderer/src/platform/tuttid/createRestartAwareFetch.ts)
  [desktop-transport.md](../../architecture/desktop-transport.md)

### Renderer `fetch()` rejects an Electron image protocol that `<img>` can load

- Symptom:
  An image rendered from a Desktop custom protocol remains visible, but
  renderer code that inlines or resizes the same image logs
  `Fetch API cannot load` and `URL scheme ... is not supported`. Catching the
  rejected promise does not suppress Chromium's console message.
- Quick checks:
  Find the scheme passed to `fetch()`. Confirm its privileged registration
  enables both `supportFetchAPI` and `corsEnabled`, runs before Electron
  `ready`, and its handler is installed on the renderer's exact `Session`.
  A working `<img>` only proves the no-CORS subresource path and protocol
  handler; it does not prove that renderer JavaScript may read the response.
- Root cause:
  The renderer page and custom protocol have different origins. Electron
  permits `<img>` to load a no-CORS custom-protocol response, but blocks a
  cross-origin `fetch()` from reading it when the scheme is not CORS-enabled.
- Fix:
  For fixed, non-sensitive image routes that renderer code must inline, register
  the scheme with `supportFetchAPI: true` and `corsEnabled: true`. Register all
  privileged Desktop schemes together in the single pre-`ready` call, then
  install handlers on every intended Session. Do not enable cross-origin reads
  for protocols that expose arbitrary or sensitive local files.
- Validation:
  Keep a contract test over every fetchable image scheme, run the Desktop
  Electron boundary checks and typecheck, and build the production Desktop
  bundle. Verify the renderer can read the response body, not only display the
  URL in an image element.
- References:
  [desktopCustomProtocolSchemes.ts](../../../apps/desktop/src/main/host/desktopCustomProtocolSchemes.ts)
  [tuttiAssetProtocol.ts](../../../apps/desktop/src/main/host/tuttiAssetProtocol.ts)
  [workspaceFileIconProtocol.ts](../../../apps/desktop/src/main/host/workspaceFileIconProtocol.ts)

### AgentGUI Mermaid flowcharts render shapes without labels

- Symptom:
  Mermaid flowcharts in AgentGUI show node borders and edges, but node and edge
  labels are blank.
- Quick checks:
  Inspect Mermaid's raw SVG before the transcript sanitizer. If labels are
  children of `<foreignObject>` while the sanitized SVG keeps shapes but has no
  `<foreignObject>` or equivalent `<text>`, the missing content is an SVG/HTML
  label-mode mismatch rather than a color or layout problem.
- Root cause:
  Mermaid enables HTML labels by default and renders them inside SVG
  `<foreignObject>` elements. AgentGUI's defense-in-depth SVG sanitizer removes
  those elements, including their text, while preserving native SVG shapes and
  paths.
- Fix:
  Configure Mermaid to emit native SVG text with `htmlLabels: false`. Add
  `htmlLabels` to Mermaid's secure configuration keys so diagram-level
  directives cannot turn HTML labels back on. Keep the post-render SVG
  sanitizer in place.
- Validation:
  Render a real flowchart containing multiline, CJK, decision, and edge labels,
  including an `init` directive that requests HTML labels. Assert the sanitized
  result contains every label as native SVG text and no `<foreignObject>`.
- References:
  [AgentMessageMermaid.tsx](../../../packages/agent/gui/shared/AgentMessageMermaid.tsx)
  [AgentMessageMermaid.integration.spec.tsx](../../../packages/agent/gui/shared/AgentMessageMermaid.integration.spec.tsx)

### AgentGUI carousel owner avatar stays a solid badge

- Symptom:
  The DOM owner avatar and other identity surfaces show the expected image, but
  the WebGL empty-home carousel keeps its solid programmatic owner marker until
  the component remounts.
- Quick checks:
  Confirm the host projects a non-empty `owner.avatarUrl`, the same URL renders
  in a normal anonymous `<img>`, and the asset response permits anonymous CORS.
  If a restart or remount makes the carousel image appear without changing the
  directory projection, inspect the carousel image loader rather than adding
  another profile or daemon request.
- Root cause:
  A transient first network failure can be latched as a decoded `null` image.
  Because the authoritative URL did not change, the carousel has no reason to
  create a new image generation and the solid fallback remains.
- Fix:
  Keep one carousel image-load owner and retry anonymous owner badges a small,
  bounded number of times. Cancellation must clear both the active image source
  and any pending retry timer. Continue using the host's authoritative owner
  projection; renderer code must not fetch a second avatar source.
- Validation:
  Inject one failed owner-image attempt, advance through the first retry delay,
  and assert that the next anonymous image resolves while icon and cover loading
  remain unchanged. Also assert that canceling a generation resolves it empty
  and clears every active source.

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
  `opacity: 0`. Also inspect `animationiteration` volume and completed CSS
  entry animations whose `fill-mode: both` leaves an identity `transform` on
  every mounted window.
- Root cause:
  CSS-hidden animation elements are still live renderers. An autoplay/looping
  Lottie, canvas, or WebGL player can keep scheduling frames and force layer
  updates across every mounted instance. CSS can produce the same pressure:
  inactive windows may keep infinite transform/opacity animations running, and
  a completed entry animation with forwards fill can retain a compositor layer
  long after its visual work ends.
- Fix:
  Mount animation players only while the animation is actually visible, and
  defer loading third-party animation runtimes until an active state needs
  them. When a workspace restores many heavy bodies, render the active body
  immediately but hydrate inactive bodies sequentially after idle, one
  animation frame at a time; keep their shells and saved geometry visible
  throughout. Once mounted, derive visual exposure from Workbench geometry and
  z-order, not keyboard focus. Pause descendant CSS animations only while a
  window is fully occluded. A partially exposed window remains fully painted;
  only a window whose frame is completely covered may use
  `content-visibility: hidden`. Release imperative resources such as WebGL
  scenes, decoded carousel images, observers, and non-passive listeners while
  fully occluded. Avoid running a body's entry animation when its host shell
  already owns the appearance transition. For delayed entry animations whose
  normal styles already match the final keyframe, use backwards fill so the
  initial keyframe covers the delay and the final identity transform is
  released. Do not rely on `opacity`, `visibility`, or off-screen placement to
  stop playback.
- Validation:
  Re-record a short DevTools trace after the fix. Idle UI should no longer show
  the hidden player's function as a high-frequency `requestAnimationFrame`
  source, and Chromium tile memory warnings should stop during idle. For
  multi-window AgentGUI changes, run
  `pnpm perf:agent-gui -- --scenario workbench-window-drag`; it moves one
  window while at least three are mounted and rejects tile-memory warnings or
  excessive background animation iterations. Use
  `--scenario workbench-fifty-window-stress` for the 50-window startup,
  background-focus, retained-DOM, geometric exposure, drag, and 50 ms
  renderer-task budgets.

### IME composition breaks fuzzy search or controlled search inputs

- Symptom:
  Chinese, Japanese, or Korean input cannot be committed in a fuzzy search,
  mention picker, or a controlled name dialog (for example Files → New folder /
  New file). Pressing Enter to accept an IME candidate may select a highlighted
  result, submit a search or create dialog, or clear/replace the partially
  composed text.
- Quick checks:
  Inspect any `keydown` handler that consumes `Enter` or `Tab` while a menu is
  open. Also inspect controlled text/`input[type="search"]` fields whose
  `value` comes from async search/controller or dialog store state and whose
  `onChange` commits on every keystroke without composition handlers.
- Root cause:
  IME candidate confirmation is delivered through composition-aware keyboard
  events. If menu shortcuts do not check `isComposing` or the `keyCode/which`
  `229` fallback, the app treats candidate confirmation as a command. If a
  controlled search or name input pushes every composition update through async
  search/controller/dialog state, stale parent values can overwrite the local
  composing buffer.
- Fix:
  In fuzzy/menu key handlers, return before command handling when
  `event.isComposing`, `event.nativeEvent.isComposing`, `keyCode === 229`, or
  `which === 229`. For controlled search or name inputs, keep a local value
  during `compositionstart`/`compositionend` (prefer
  `useComposedInputValue`), commit to the controller on `compositionend`, and
  ignore stale parent values until the parent catches up. Guard form submit
  while composition is active.
- Validation:
  Add a unit test for the IME guard or input sync state, then manually type a
  Chinese query/name and confirm Enter accepts the candidate instead of
  selecting a result or submitting the field.
- References:
  [richTextIme.ts](../../../packages/ui/rich-text/src/editor/richTextIme.ts)
  [useComposedInputValue.ts](../../../packages/ui/react-hooks/src/useComposedInputValue.ts)
  [WorkspaceFileManagerMenus.tsx](../../../packages/workspace/file-manager/src/ui/WorkspaceFileManagerMenus.tsx)
  [WorkspaceFileReferencePickerTree.tsx](../../../packages/workspace/file-reference/src/ui/internal/reference/WorkspaceFileReferencePickerTree.tsx)
  [IssueManagerSidebarSections.tsx](../../../packages/workspace/issue-manager/src/ui/internal/shell/IssueManagerSidebarSections.tsx)

### Controlled list input loses focus after every edit

- Symptom:
  Typing or deleting one character in a controlled input inside a rendered list
  immediately ends the input state or clears focus.
- Quick checks:
  Inspect the nearest mapped row's React `key`. Confirm the key does not include
  the input value or another field that changes in the input's `onChange` path.
- Root cause:
  Each edit changes the row key, so React treats the row as a different element
  and unmounts the focused input before mounting its replacement.
- Fix:
  Build list-row keys only from stable row identity. For append/remove-only
  drafts without a persisted row ID, a stable parent identity plus the row
  position is acceptable; do not include editable values merely to make the key
  look unique.
- Validation:
  Keep a regression test that rejects editable values in the row key. Manually
  type and backspace repeatedly in each affected input and confirm that focus
  and selection remain in the same field.
- References:
  [WorkspaceSettingsPanel.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceSettingsPanel.tsx)

### External-store snapshots churn because derived reads lose reference stability

- Symptom:
  `useSyncExternalStore` consumers re-render continuously, lose memoization
  wins, or behave as if external state changed even when the underlying store
  snapshot did not.
- Quick checks:
  If the issue starts in a React component or shared React hook, look for a
  direct `useSyncExternalStore` call or an ad hoc subscription wrapper and
  route it through `@tutti-os/ui-react-hooks`.
  If the issue starts in a non-React adapter that exposes `getSnapshot()`,
  check whether it rebuilds objects or arrays on every read instead of reusing
  a derived snapshot while the source snapshot is unchanged.
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
- Validation:
  Add or update a regression test that asserts repeated `getSnapshot()` calls
  return the same reference before a real state change. Then run the affected
  package tests, `pnpm typecheck`, and the relevant renderer build checks when
  the subscriber is consumed by desktop UI.
- References:
  [packages/ui/react-hooks/src/useExternalStoreSnapshot.ts](../../../packages/ui/react-hooks/src/useExternalStoreSnapshot.ts)
  [packages/ui/react-hooks/src/useExternalStoreSelector.ts](../../../packages/ui/react-hooks/src/useExternalStoreSelector.ts)
  [packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts](../../../packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts)
  [packages/workbench/surface/src/host/missionControlAdapter.ts](../../../packages/workbench/surface/src/host/missionControlAdapter.ts)
  [packages/workbench/surface/src/host/missionControlAdapter.test.ts](../../../packages/workbench/surface/src/host/missionControlAdapter.test.ts)

### React Compiler removes a manual identity memo

- Symptom:
  React profiling reports a grouped prop as referentially unequal but deeply
  equal on every render even though source code wraps it in `useMemo`.
- Quick checks:
  Inspect the renderer's dev transform and production bundle. A source pattern
  such as `useMemo(() => nextValue, [nextValue.field])` may compile to
  `const value = nextValue`, restoring the fresh input reference.
- Root cause:
  The memo callback returns an existing input object while its dependency list
  intentionally describes selected fields. React Compiler infers the input
  object as the value dependency and may remove this identity-only memo.
- Fix:
  Build an explicit projection object from every semantic field and let React
  Compiler cache that allocation by those fields. Do not use a component ref or
  `useMemo(() => freshInput)` to absorb upstream reference churn.
- Validation:
  Add a compiler regression test for the projection, run the desktop production
  build, and inspect the emitted cache conditions. They must compare semantic
  fields rather than assign the fresh input object directly. Re-record a React
  performance trace to verify deeply-equal grouped-prop changes disappear.
- References:
  [useStableDesktopAgentGUIHostProps.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/ui/useStableDesktopAgentGUIHostProps.ts)
  [useStableDesktopAgentGUIHostProps.test.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/ui/useStableDesktopAgentGUIHostProps.test.ts)

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
  [useWorkspaceWorkbenchShellRuntime.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/useWorkspaceWorkbenchShellRuntime.tsx)

### Dock entry is open but its state indicator is missing

- Symptom:
  A Dock icon is visible and its application window is open or minimized, but
  the state dot is absent. The problem may affect one migrated node family or
  every application in one Dock placement.
- Quick checks:
  Inspect the slot's `data-node-state`. If it is `closed`, compare the node's
  persisted `dockEntryId` with the rendered entry id before inspecting CSS. If
  it is `open` or `minimized`, inspect placement selectors for rules that hide
  or clip the shared `::before` indicator. Reproduce with both an internal entry
  and a `workspace-app:<appId>` entry to separate identity from presentation.
- Root cause:
  `dockEntryId` is exact durable affinity. A historical or provider-specific
  value does not match a newer aggregate entry and therefore resolves to
  `closed`. Separately, a placement-specific CSS override can suppress a
  correctly resolved indicator for every application in that layout.
- Fix:
  Normalize stale durable affinity through an idempotent daemon migration and
  make all new launch paths write the canonical entry id. Keep Workbench exact
  matching intact. Render the shared indicator for both `open` and `minimized`
  in every supported placement, changing only its position.
- Validation:
  Cover migrated snapshots, canonical new launches, third-party Workspace App
  affinity, and bottom/left indicator selectors. Verify `closed` has no dot and
  both `open` and `minimized` do.
- References:
  [docs/architecture/workbench-dock-model.md](../../architecture/workbench-dock-model.md)
  [packages/workbench/surface/src/host/dockEntries.ts](../../../packages/workbench/surface/src/host/dockEntries.ts)
  [packages/workbench/surface/src/styles/workbench.css](../../../packages/workbench/surface/src/styles/workbench.css)

### Effect cleanup leaves mounted refs false in React development

- Symptom:
  A React component works far enough to start async work, but later promise
  continuations silently skip state updates behind an `isMountedRef.current`
  guard. In development, the UI can remain permanently stuck in a loading
  state even though the backend request succeeded.
- Quick checks:
  Search the component for an effect cleanup that sets an `isMountedRef` or
  similar lifecycle ref to `false`. If the effect body returns the cleanup
  directly, verify the setup path also sets the ref back to `true`.
- Root cause:
  React development and StrictMode can run an effect cleanup followed by setup
  while the component continues to be used for validation. If setup does not
  restore the mounted ref, later async callbacks treat the live component as
  unmounted and drop state updates.
- Fix:
  Use an effect body that sets the mounted ref to `true` before returning the
  cleanup that sets it to `false`.
- Validation:
  Run the affected React package tests and cold-start the consuming desktop UI,
  because hot reload can preserve the stale ref value from before the fix.
- References:
  [useAgentGUINodeController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)

### Dock popup stays on skeletons after preview capture succeeds

- Symptom:
  Dock popup cards remain as skeletons even though renderer diagnostics report
  `dock_preview_capture.succeeded`.
- Quick checks:
  Compare `dock.popup.preview_capture.started` and
  `dock.popup.preview_capture.resolved`. If capture starts once but the popup
  effect runs twice in development, inspect whether the first cleanup fences
  the result while the replayed effect skips the same pending capture.
- Root cause:
  React StrictMode replays effect setup and cleanup. Electron capture cannot be
  canceled, so a module-level pending marker can outlive the effect invocation
  that started it. Treating that invocation as canceled drops its successful
  result, while the replay cannot start a replacement.
- Fix:
  Keep the pending marker until the native capture settles. Commit the result
  when the popup is still mounted and the item's semantic preview identity is
  still current, regardless of which equivalent effect invocation issued the
  capture.
- Validation:
  Render the popup under `StrictMode`, defer the capture promise until effect
  replay completes, and assert one native capture plus a rendered image.
- References:
  [docs/architecture/workbench-dock-model.md](../../architecture/workbench-dock-model.md)
  [WorkbenchHostDockPopup.tsx](../../../packages/workbench/surface/src/host/WorkbenchHostDockPopup.tsx)

### Some background Dock previews remain as skeletons

- Symptom:
  A multi-window Dock popup renders foreground or previously cached previews,
  but windows that have never been foreground remain visually identical to
  loading skeletons.
- Quick checks:
  Correlate `dock.popup.preview_capture.started` with
  `dock.popup.preview_capture.resolved`. An immediate `hasPreview: false`
  without a native `dock_preview_capture.started` event means the host rejected
  native capture before IPC. Check whether the node is background and whether
  its revision has a persisted preview.
- Root cause:
  Electron's rectangular capture reads the currently composited foreground
  pixels. The desktop host correctly rejects a background node because its
  rectangle contains another window. AgentGUI may also be unhydrated or have
  inactive imperative resources when `surface.isVisible=false`, so a fresh DOM
  snapshot can produce a blank image. Treating an unavailable result as a
  reusable cache entry also prevents a later foreground attempt for the same
  revision.
- Fix:
  Keep native capture as the foreground high-fidelity path. Background and
  minimized popup nodes first reuse a successful memory or persistent image.
  Treat the bounded Dock PNG as one Node-level latest artifact shared by popup
  and minimize capture: read shared memory first, then read the unrevisioned
  persistent latest identity and exact revision in parallel. Prefer the shared
  latest entry and promote an exact-revision fallback when used. If those
  sources miss, serialize DOM-cloned snapshots for non-minimized background
  nodes, yield the renderer task queue between clones, deduplicate them by
  preview identity and revision, and write successful images to the one
  shared-latest identity. Keep the full-resolution Genie animation texture
  separate. Do not DOM-capture minimized nodes because their content may be
  unhydrated. Keep an unavailable result local to the mounted popup so reopening
  can retry after the node becomes foreground. Show a static terminal
  placeholder instead of a loading skeleton when no successful image exists.
- Validation:
  Cover native-null plus exact-cache promotion, shared memory and unrevisioned
  persisted-cache reuse before DOM capture, single shared-latest writes after
  memory or DOM success, and reopen the popup to prove that a prior unavailable
  result does not block a later successful capture.
- References:
  [docs/architecture/workbench-dock-model.md](../../architecture/workbench-dock-model.md)
  [WorkbenchHostDockPopup.tsx](../../../packages/workbench/surface/src/host/WorkbenchHostDockPopup.tsx)

### AgentGUI crashes while unmounting a Monaco diff

- Symptom:
  AgentGUI's React subtree crashes while a file diff is being hidden, replaced,
  or removed. Renderer logs repeatedly report
  `TextModel got disposed before DiffEditorWidget model got reset`. Long
  histories with many expanded edit tools make the failure easier to trigger.
- Quick checks:
  Confirm the exception occurs during a diff component cleanup rather than
  while parsing the patch. Inspect whether either Monaco text model is disposed
  while the diff editor still returns it from `getModel()`. Repeatedly mounting
  and unmounting one diff is a focused reproduction.
- Root cause:
  A diff wrapper disposed its owned original and modified text models before
  detaching them from `DiffEditorWidget`. Monaco listens for model disposal and
  deliberately throws while a disposed model is still attached. Keeping the
  models alive avoids the exception but leaks one pair per diff.
- Fix:
  Let the Agent GUI package own the diff editor and both models. On cleanup,
  call `diffEditor.setModel(null)` first, dispose the diff editor second, and
  dispose the owned original and modified models last. Cancel asynchronous
  Monaco loading on unmount so a late module resolution cannot create detached
  resources.
- Validation:
  Keep a component test that records the exact detach/editor/model disposal
  order, a test for unmount before Monaco finishes loading, and a test proving
  content changes reuse the mounted editor. Run the Agent GUI package test and
  typecheck lanes.
- References:
  [AgentMonacoDiffViewer.tsx](../../../packages/agent/gui/shared/agentConversation/components/tool-renderers/file-diff/AgentMonacoDiffViewer.tsx)
  [monaco-react issue 647](https://github.com/suren-atoyan/monaco-react/issues/647)
  [monaco-editor issue 4779](https://github.com/microsoft/monaco-editor/issues/4779)

### Workbench node body warns about updating WorkbenchNodeLayer during render

- Symptom:
  Opening a workbench node shows React's warning that
  `WorkbenchNodeLayer` is updated while rendering a different node body
  component. The node may stay on a loading surface even though the backing
  request succeeds. A retained request controller can also work for the
  restored item but silently ignore later selections: for example, AgentGUI
  shows the conversation rail while every newly selected conversation has a
  blank timeline and the daemon receives no message-list request.
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
  For request-owning controllers, switch between at least two uncached items
  after the initial render and confirm that each selection reaches the backend.
- References:
  [workspaceFilePreviewNodeController.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceFilePreviewNodeController.ts)
  [WorkspaceFilePreviewNodeBody.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceFilePreviewNodeBody.tsx)
  [useAgentConversationMessagePaging.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentConversationMessagePaging.ts)

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
  initialization stall. For prop identity churn, opt in to why-did-you-render
  with `VITE_TUTTI_WHY_DID_YOU_RENDER=1 make dev-gui`, or set
  `localStorage.tuttiWhyDidYouRender = "1"` in DevTools and reload the renderer.
  Do not leave it enabled during normal development: it tracks every component
  and hook, and restoring a large AgentGUI session directory can then block the
  renderer long enough to keep Workbench hydration and the Dock non-interactive.
  For AgentGUI render storms, trace the full
  `engine -> selector -> projection -> controller -> section` chain. Separate
  real summary-field changes from reference-only array, object, or callback
  changes; a memoized leaf cannot contain churn created at the selector boundary.
  On a Rail click, count updated sections and rows, then inspect whether a global
  active ID, the full provider-dependent label object, or scope-dependent action
  callbacks changed on every section. Thousands of Tooltip, Popper, Dropdown,
  or ContextMenu component renders usually amplify that upstream fan-out rather
  than identify its owner. React DevTools component tracks add profiling cost,
  so use them to locate the chain but recapture without the profiler for timing.
  When the stack starts in `setRef`, inspect Radix `asChild` composition before
  changing business state. In particular, check whether Tooltip and Dropdown
  triggers both clone the same DOM child and merge callback refs, or whether a
  transient status row mounts a Tooltip trigger while its message changes.
  Also reject Tooltip/Select nesting where `TooltipTrigger` directly wraps a
  `SelectTrigger`; both primitives install a stateful Popper anchor on the same
  button.
- Root cause:
  React StrictMode can intentionally replay setup/cleanup in development, but a
  continuously increasing render count usually means a parent is passing a new
  object/function every render or an effect writes state from a dependency that
  changes on every render. An external-store selector can also project a fresh
  list for every unrelated engine event, after which a container rebuilds command
  callbacks and fans one update out to every list section. A render-budget test
  that injects an already-stable view model bypasses this production chain and
  cannot detect that regression. A container-owned relative-time interval can
  cause the same fan-out when its timestamp is passed through every section and
  row instead of being consumed at the timestamp leaf. A globally threaded
  selection ID, a provider-dependent full label object passed into Rail, or
  callbacks rebuilt for each target scope can likewise invalidate every
  section even though only one or two rows changed visually. If every section
  owns closed Tooltip/Popper/Dropdown/ContextMenu content, that upstream
  invalidation also executes thousands of invisible primitive components. A
  changing lock, drag-disabled, or batch-disabled prop on one memoized section
  header has the same effect: React must execute the whole header and its
  mounted Radix trigger tree even when only one native attribute or one open
  menu item changes. A combined Context object merely moves that fan-out from
  props to every Context consumer. Keeping those Context providers inside the
  memoized section also executes item projection before the update reaches the
  narrow consumer. A project reorder can show a valid insertion indicator but
  never commit when only the section owns `drop`: releasing over a gap bypasses
  that handler and global cleanup clears the valid drag state. A measurement
  effect that includes the state it writes in its dependencies can repeat the
  resulting layout read once more.
- Fix:
  Stabilize the value at the ownership boundary, or remove derived presentation
  values from bidirectional state. For external/workbench state, only sync
  canonical identifiers and derive display text from the owning service. In
  AgentGUI, select the narrow render projection with a render-field equality
  function, keep command callbacks stable, and separate Rail render equality
  from active-session semantic equality. Stabilize usage, commands, prompt
  queue, quota, session-chrome, and host callback projections at their owning
  selector/controller boundary; do not clone canonical arrays while assembling
  the view model. For a paged Rail, project only canonical sessions referenced
  by current section, search-result, or reconciliation ids, then structurally
  share unchanged summary items. Let time-label consumers subscribe directly
  to a shared renderer-realm relative-time external store. The store starts one
  timer for its first subscriber and clears it after its last unsubscribe.
  Project selection into the section that owns the active canonical or overlay
  row, passing `null` to unrelated sections. Give Rail a dedicated locale-bound
  label projection instead of the provider-dependent full view labels. Keep
  shared section actions referentially stable and read the latest scope at event
  time. Split stable section header/action chrome from changing item data: pass
  scalar presentation fields and stable event-time actions, never the section
  object. Keep menu root and trigger mounted, while rendering portaled menu
  content only during its view-local open state. Do not move disclosure into a
  controller/store or copy Session/project semantics to obtain this isolation.
  Split large headers into stable identity, create-action, menu, and frame
  render islands. Project frequently changing derived booleans through
  separate primitive view Contexts owned outside the memoized Section so
  project drag state reaches only the native draggable frame, project action
  lock reaches only the forwarded-ref button leaf and open project menu, and
  batch deletion state reaches only open menu content. Keep event-time lock
  readers as the action-delivery guard; Context is only the current
  presentation projection. Closed menus should have no batch-state consumer.
  Keep the project header as the drag source and let each project section update
  insertion position across its full area. Let the Rail scroll viewport own the
  final drop so section gaps commit the last visible valid position.
  Remove a measured state value from an effect dependency when the effect only
  writes, but never reads, that value.
  During Rail reconciliation, expose a stable lock reader so
  portaled menu actions can check current state without passing a changing
  boolean through every section. For composed menu actions, attach the Tooltip
  trigger to a stable wrapper and the Dropdown trigger to the actual
  forwarded-ref button. Do not nest both `asChild` triggers onto the same
  element: their ref callbacks can repeatedly detach and attach each other until
  React aborts the renderer tree. For truncated, non-interactive status text,
  prefer a native `title` on the text element; it preserves access to the full
  message without introducing a stateful anchor ref during session transitions.
  Select triggers should likewise keep their native `title` and must not be
  wrapped by a second Tooltip trigger.
- Validation:
  With why-did-you-render enabled, reproduce once and confirm the noisy
  component lists the expected prop or hook difference. Then disable the tool
  and run the affected renderer tests plus desktop typecheck. AgentGUI budget
  tests must dispatch a real engine update and assert the unrelated Rail subtree
  stays at zero renders; do not replace this with a manual view-model rerender
  that reuses the Rail reference by construction. For relative-time clocks,
  assert multiple time-label consumers share one interval, the last unmount
  clears it, and a tick updates labels without rerendering the parent rows. Add
  identity tests for locale-bound Rail labels and scope-bound actions, including
  invoking a callback retained before a scope switch. Assert active selection
  projects only into its owning section. Then recapture the same interaction
  without React Profiler instrumentation before claiming timing improvement.
  Add a render-budget test proving item replacement does not rerender stable
  section chrome, including an item-empty transition that changes batch-action
  availability. While a menu is open, assert lock changes still update its
  trigger and disabled items. For lazy menu content, test pointer/context-menu
  opening, keyboard-origin focus, Escape dismissal, action delivery, and
  event-time lock rejection. Add a composition regression test for shared
  Tooltip/Dropdown actions and manually create a new conversation, since an
  empty-to-populated Rail transition can be the first time the faulty trigger
  mounts.
- References:
  [main.tsx](../../../apps/desktop/src/renderer/src/main.tsx)
  [whyDidYouRender.ts](../../../apps/desktop/src/renderer/src/lib/whyDidYouRender.ts)
  [useAgentGUIConversationRailQuery.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationRailQuery.ts)
  [useAgentGUIConversationRailQuery.search.spec.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationRailQuery.search.spec.tsx)
  [agentGuiConversationRailQuerySnapshot.spec.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/agentGuiConversationRailQuerySnapshot.spec.ts)
  [AgentGUIConversationRailClock.spec.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIConversationRailClock.spec.tsx)
  [agentGUIConversationRailLabels.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/view/agentGUIConversationRailLabels.ts)
  [useAgentGUIConversationRailViewState.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/view/useAgentGUIConversationRailViewState.ts)
  [AgentGUIConversationRailSection.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIConversationRailSection.tsx)
  [AgentGUIConversationRailSectionHeader.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIConversationRailSectionHeader.tsx)
  [AgentGUIConversationRailItem.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIConversationRailItem.tsx)
  [AgentSessionChrome.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/AgentSessionChrome.tsx)

### Provider Rail tile drags but does not reorder

- Symptom:
  A Provider Rail tile shows the native drag image, but the insertion indicator
  does not follow rail gaps and dropping does not persist a new order.
- Quick checks:
  Inspect each `[data-provider-tile="true"]` element. Confirm the rendered
  `data-*` identity and its camel-cased `dataset` reader name match exactly.
- Root cause:
  A terminology migration can rename the dataset reader without renaming the
  DOM attribute. Container-level hit testing then discards every tile because
  each target ID appears empty, while native dragging still makes the feature
  look partially functional.
- Fix:
  Keep the DOM identity attribute and dataset reader aligned. Cover the Rail
  container path, not only a tile's own `dragover`: simulate dragging over a
  gap, assert the insertion indicator, drop, and verify persisted order.
- Validation:
  Reorder through a rail gap, reload, and confirm the new order remains.
- References:
  [AgentGUIProviderRail.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIProviderRail.tsx)
  [AgentGUIProviderRail.spec.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIProviderRail.spec.tsx)

### Dense list panel stutters when mounted or resized

- Symptom:
  Opening a card or row-heavy Workbench panel pauses before it becomes
  interactive, or resizing the panel produces repeated layout work even though
  the visible content is simple.
- Quick checks:
  Record a Chrome Performance trace and inspect the opening interval for
  repeated `ResizeObserver` callbacks, animation-frame callbacks, layout reads,
  and React commits. Search repeated item components for per-item observers,
  global `resize` listeners, and reads such as `scrollWidth`, `clientWidth`,
  `scrollHeight`, or `clientHeight`. Count these subscriptions per rendered
  item instead of evaluating only one card in isolation. For a floating
  Workbench node, also check whether every intermediate frame update rerenders
  the complete node body. For wallpaper-aware chrome, count canvas draws and
  pixel readbacks while resizing.
- Root cause:
  A text-overflow tooltip or similar decoration can create an observer and an
  initial layout measurement for every repeated text node. Mounting the whole
  list then schedules many layout reads and state updates together. Permanent
  `will-change` hints on every item can add avoidable compositing work at the
  same time. A host adapter can also treat every drag or resize frame as a body
  data change even though the Workbench shell already owns live geometry.
  Recreating a canvas and reading the same static wallpaper pixels on each
  resize frame adds independent main-thread work.
- Fix:
  When overflow state is needed only to decide whether an interaction tooltip
  should open, measure on pointer or focus interaction and reuse a pure overflow
  predicate. Keep continuous observation only when the UI must react while it
  remains visible; in that case prefer one owner-level observer over one
  observer per repeated child. Do not leave `will-change` on idle list items.
  Let the outer Workbench shell apply live frame geometry; expensive body
  adapters may gate frame-only renders with body-context `isDragging` and
  `isResizing`, then consume the final frame when the interaction ends. Cache
  immutable wallpaper image samples and read cached RGBA bytes instead of
  repeating `drawImage` or `getImageData` during resize.
- Validation:
  Verify the panel mounts without item-level observer callbacks, then confirm
  truncated and non-truncated text still show the correct tooltip after a
  resize. Run the owning package tests, renderer boundary checks, and the
  desktop production build.
- References:
  [AppCard.tsx](../../../packages/workspace/app-center/src/ui/AppCard.tsx)
  [appCardTextOverflow.ts](../../../packages/workspace/app-center/src/ui/appCardTextOverflow.ts)
  [hostNodeContext.ts](../../../packages/workbench/surface/src/host/hostNodeContext.ts)
  [dockWallpaperSampling.ts](../../../packages/workbench/surface/src/host/dockWallpaperSampling.ts)

### Adjacent sidebar animation repeatedly reflows its content and message flow

- Symptom:
  Opening or closing a right sidebar stutters for the full duration of its slide
  animation. A Performance trace shows repeated layout and paint work in both
  the sidebar and its adjacent message flow even when the panel body was mounted
  lazily.
- Quick checks:
  Inspect the flex or grid boundary shared by the main content and sidebar.
  Search the animated shell for `transition-[width]`, `flex-basis`, layout-bound
  keyframes, permanent `will-change` hints, and native window bounds animation.
  If a sidebar contains responsive grids, confirm its available width is not
  changing on every animation frame.
- Root cause:
  Animating a sidebar's layout width makes the browser recompute both sibling
  layout trees every frame. Running an Electron native bounds animation at the
  same time changes the renderer viewport too, so the two animations can cause
  additional message-flow reflow even when they have matching durations.
- Fix:
  Commit the final sidebar width and native window bounds once. Keep the panel
  beside the main content in normal layout, isolate its subtree with layout and
  paint containment, and use only `transform` or `opacity` for the optional
  fixed-size inner-panel entrance. Delay expensive first-use content until that
  compositor entrance completes, then retain it while hidden.
- Validation:
  Add a structural regression test that rejects layout-property transitions and
  native bounds animation. Re-record the opening trace and confirm the interval
  no longer contains a layout task for every animation frame, then run desktop
  tests, typecheck, renderer boundaries, and the production build.
- References:
  [StandaloneAgentToolSidebar.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/StandaloneAgentToolSidebar.tsx)
  [standaloneAgentWindowBounds.ts](../../../apps/desktop/src/main/windows/standaloneAgentWindowBounds.ts)

### Header divider drifts from a resizable sidebar

- Symptom:
  A Workbench node's custom header divides its chrome at the sidebar boundary,
  but that divider moves ahead of or behind the body sidebar while the resize
  handle is dragged.
- Quick checks:
  Identify where the header and body read their widths. If the body owns a
  descendant CSS variable while an effect copies the value to a Workbench
  ancestor for the header, there are two update paths. Also check whether
  `grid-template-columns`, `width`, or the resize handle's position keeps a
  transition active during pointer movement.
- Root cause:
  A CSS variable declared inside the body cannot inherit upward into a sibling
  header. Copying React state to an ancestor in a passive effect makes the
  header update in a different phase, while a persistent layout transition
  makes one boundary chase each pointer position. Rapid pointer movement
  exposes the divergence even when both paths eventually settle on the same
  number.
- Fix:
  Put the live width variable on the lowest DOM scope shared by header and body,
  and update that single variable directly from `pointermove`. Keep the
  in-progress width in the interaction ref, update ARIA imperatively, and
  commit React state when the resize ends. Mark the resize lifecycle explicitly
  and disable layout and handle-position transitions until `pointerup`,
  `pointercancel`, or lost pointer capture. A standalone surface without a
  shared Workbench ancestor can own the same variable on its layout root.
- Validation:
  Unit-test that the layout publisher selects the shared Workbench scope,
  updates it in place, and cleans it up. Run the owning package tests,
  typecheck, and renderer/UI boundary checks, then visually drag in both
  directions and confirm the header and body dividers remain coincident.
- References:
  [IssueManagerSidebarLayout.ts](../../../packages/workspace/issue-manager/src/ui/internal/shell/IssueManagerSidebarLayout.ts)
  [useIssueManagerShellView.ts](../../../packages/workspace/issue-manager/src/ui/internal/shell/useIssueManagerShellView.ts)
  [useAgentGUIConversationRailResizePointerMove.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/view/useAgentGUIConversationRailResizePointerMove.ts)

### Renderer services initialize twice and consume one event twice

- Symptom:
  One daemon lifecycle transition produces duplicate renderer work, such as two
  identical completion toasts, repeated reconcile requests, or two service
  instance IDs applying the same state transition.
- Quick checks:
  Compare daemon and renderer logs by workspace, session, turn, and event time.
  Confirm whether the daemon emitted one settled transition while the renderer
  applied the same payload twice. Check `workspace_runtime.created`,
  `workspace_runtime.committed`, and `workspace_runtime.duplicate_detected` by
  `rendererInstanceId` and `runtimeInstanceId` before blaming the transport.
- Root cause:
  A renderer-window service graph was constructed from React render instead of
  an explicit renderer bootstrap owner. A discarded render or remounted host
  could leave its subscriptions alive because cleanup belonged only to the
  committed component tree and several services did not retain their
  unsubscribe handles.
- Fix:
  Dynamically load and create one workspace-window runtime before
  `createRoot().render`, then pass it through props and DI context. Give that
  runtime one idempotent `dispose()` that releases controllers, service
  subscriptions, analytics leases, host listeners, DI services, and the shared
  event-stream client. Keep a stable workspace/session/turn toast ID only as a
  presentation-boundary defense, not as the ownership fix.
- Validation:
  Assert one active runtime per renderer realm, zero subscriptions after
  disposal, and one notification for repeated delivery of the same turn. Run
  targeted service tests, TypeScript lint and typecheck, changed-aware checks,
  and the production desktop build.
- References:
  [main.tsx](../../../apps/desktop/src/renderer/src/main.tsx)
  [createWorkspaceWindowContainer.ts](../../../apps/desktop/src/renderer/src/app/windows/workspace/createWorkspaceWindowContainer.ts)
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [workspaceAgentOutcomeNotification.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceAgentOutcomeNotification.ts)

### Dialog action reacts to Enter but ignores pointer clicks

- Symptom:
  A dialog action succeeds from an input's Enter handler, but clicking its
  visible action button does nothing. No request, caught error, or busy state is
  produced.
- Quick checks:
  Trace `pointerdown`, `pointerup`, `click`, and the command boundary without
  logging field contents. If both pointer events arrive but `click` and the
  command do not, stop debugging the daemon or persistence layer.
- Root cause:
  Electron, a modal interaction layer, or surrounding Workbench chrome can
  suppress the synthesized `click` even though the button receives the pointer
  sequence. A handler wired only to `onClick` therefore never runs.
- Fix:
  Handle `pointerup` only after a matching primary-button `pointerdown`; clear
  the armed action on `pointerleave` and `pointercancel`. If the button instead
  establishes pointer capture explicitly, also clear on lost capture and
  validate that the release coordinates remain inside the action before
  executing it. Preserve keyboard activation explicitly, retain an
  assistive-technology click-only path, and guard the async action with a
  synchronous in-flight ref so multiple event paths cannot dispatch the command
  twice.
- Validation:
  Cover pointer activation, the following synthesized mouse click, keyboard
  activation, assistive click-only activation, unmatched pointerup, canceled
  pointer sequences, blank input, and cancellation. Assert the command runs
  exactly once for each accepted action.
- References:
  [AgentGUIRenameConversationDialog.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIRenameConversationDialog.tsx)

### Daemon validation error appears as untranslated developer text

- Symptom:
  A renderer action shows an English daemon message such as a validation
  failure while the UI locale is not English.
- Quick checks:
  Inspect the protocol error's `code`, `reason`, and `params`. If the reason is
  generic and the UI falls through to `developerMessage`, the transport lost
  the stable domain identity needed by i18n.
- Root cause:
  The daemon classified a specific business validation error as a generic
  request failure. The renderer then had no stable key and exposed diagnostic
  text as user-facing copy.
- Fix:
  Define a stable daemon error identity, publish a documented protocol `reason`
  with interpolation-only `params`, then translate that reason in the owning UI
  package. Never infer user-facing errors by matching developer-message text.
- Validation:
  Test service error identity, protocol classification and params, every locale
  dictionary, and renderer mapping while an English `developerMessage` is
  present. Run API-generation and i18n consistency checks.
- References:
  [apierrors.go](../../../services/tuttid/apierrors/apierrors.go)
  [agentGuiController.errors.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/agentGuiController.errors.ts)

### Mask-backed icon renders as a solid color block

- Symptom:
  A monochrome icon has the expected size and color but renders as a solid
  square or rectangle. Other icons backed by the same packaged SVG still render
  normally.
- Quick checks:
  Confirm the SVG import resolves to a CSS-safe self-contained data URL, then
  inspect how that URL reaches the element. If the icon background applies but
  the mask does not, look for a dynamic URL passed through a custom property
  into the `mask` or `-webkit-mask` shorthand. If both mask-image longhands are
  present, verify that their source is the dedicated monochrome `maskIconUrl`,
  not the target's primary color `iconUrl`.
- Root cause:
  Either the dynamic mask source crossed two parsing boundaries and the
  composed declaration was rejected, or the renderer conflated two Agent
  Directory roles by using the primary identity image as a monochrome mask. An
  opaque primary image produces a full-box alpha mask even when the CSS is
  valid.
- Fix:
  Keep the dynamic image source on the element through the explicit
  `maskImage` and `WebkitMaskImage` longhands. Keep static position, repeat, and
  size declarations in CSS longhands. Do not route dynamic image URLs through a
  custom property into a shorthand. Preserve Agent Directory icon roles: render
  `maskIconUrl` through the mask element and render an `iconUrl` without a
  matching mask as a normal image.
- Validation:
  Assert the rendered element owns both mask-image longhands and that the
  packaged SVG remains a CSS-safe data URL. Verify the affected icon in the
  consuming renderer rather than inferring success from unrelated icon paths.
- References:
  [AgentGUIConversationRailItem.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIConversationRailItem.tsx)
  [agentactivity.css](../../../packages/agent/gui/app/renderer/agentactivity.css)

### Restored fullscreen window overflows after the host surface becomes smaller

- Symptom:
  A Workbench node was fullscreen before restart. After the room or workspace
  reopens on a smaller non-fullscreen host surface, exiting the node's
  fullscreen mode restores a window wider or taller than the Workbench desktop.
- Quick checks:
  Inspect the persisted node's `displayMode`, `frame`, and `restoreFrame`.
  Compare both frames with the current Workbench safe layout, not the native
  Electron window bounds. Reproduce by dispatching `exitFullscreen` directly;
  if the first invalid state appears in the reducer, CSS clipping is only the
  final symptom.
- Root cause:
  Historical snapshots stored absolute node frames without the surface and safe
  layout that produced them. Fullscreen restore recomputed the visible
  fullscreen frame but kept a stale hidden `restoreFrame`, then copied it
  directly back to `frame` on exit.
- Fix:
  Persist an additive snapshot `layoutBasis`, map all durable frame-bearing
  state from the saved safe layout into the current safe layout during initial
  host restore, and clamp the `exitFullscreen` transition as a final invariant.
  Keep snapshots without a basis on a conservative bounds-only compatibility
  path.
- Validation:
  Cover a fullscreen snapshot restored from a larger basis to a smaller
  surface, an old snapshot with no basis, and direct reducer exit with a stale
  restore frame. Verify the OpenAPI and generated Go contracts retain
  `layoutBasis` through the daemon boundary.
- References:
  [schema.json](../../../packages/workbench/snapshot/src/schema.json)
  [snapshotLayout.ts](../../../packages/workbench/surface/src/core/snapshotLayout.ts)
  [session.ts](../../../packages/workbench/surface/src/host/session.ts)
  [reducer.ts](../../../packages/workbench/surface/src/core/reducer.ts)

### Hidden workspace owner loads but its first IPC request times out

- Symptom:
  A launcher creates a hidden standalone workspace or Agent window and Electron
  reports `did-finish-load`, but the first request to the renderer times out.
  Repeated launcher shortcuts may appear inert while the temporary surface is
  still waiting on that request.
- Quick checks:
  Compare the hidden window's load/ready timestamps with registration of the
  React/preload request handler. A fixed timeout after `did-finish-load` with no
  matching renderer response indicates that the request was sent before the
  application handler existed, not that the daemon or Agent provider was slow.
- Root cause:
  Browser-window load readiness is a document boundary, while the request owner
  is installed later by a React effect. IPC delivery is not replayed for a
  listener registered after the message, so a one-shot request can be lost.
- Fix:
  Have the preload announce readiness only after installing the request
  listener, clear readiness when it detaches, reloads, crashes, or is destroyed,
  and make the main-process caller await that signal before sending. Do not use
  sleeps or `did-finish-load` as a substitute for capability readiness.
- Validation:
  Assert that a pending main-process request remains blocked before the ready
  signal, proceeds afterward, and returns to pending when the listener detaches
  or the renderer reloads. Cover StrictMode's setup/cleanup replay so a listener
  removed in the same turn never announces stale readiness.
- References:
  [workspaceAppRendererReadiness.ts](../../../apps/desktop/src/main/ipc/workspaceAppRendererReadiness.ts)
  [workspaceAppExternal.ts](../../../apps/desktop/src/preload/api/workspaceAppExternal.ts)

### Embedded Composer loses model controls or locks the whole draft while options load

- Symptom:
  A launch surface built from Quick Composer has no model or reasoning control,
  or loading those options disables prompt editing, attachments, and project
  selection together with send.
- Quick checks:
  Inspect the exact target/project composer-options response at the host
  boundary. If it contains models and reasoning but Quick Composer receives
  only a reduced image-capability flag, the adapter discarded presentation
  authority. If the response is pending and `presentationEditorDisabled` is
  true, loading was promoted into the whole-draft gate.
- Root cause:
  Quick Composer intentionally owns no option-loading lifecycle. A host that
  drops `AgentActivityComposerOptions` must fabricate an empty settings VM, and
  a host that maps its refresh flag to the top-level `disabled` prop also locks
  unrelated canonical Composer controls.
- Fix:
  Pass authoritative options, controlled sparse draft settings, their change
  callback, and the loading flag as one all-or-nothing Quick Composer
  capability. Reuse the canonical Composer settings projection and menus, and
  expose only fields the embedding activation adapter preserves. During
  refresh, disable settings controls and submit only; reserve the whole-draft
  disabled gate for an actual host-level lock.
- Validation:
  Cover visible model and reasoning values, settings patch delivery, editable
  rich text and references during refresh, and disabled settings/send controls.
- References:
  [AgentGUIQuickComposer.tsx](../../../packages/agent/gui/AgentGUIQuickComposer.tsx)
  [DesktopCaptureWindow.tsx](../../../apps/desktop/src/renderer/src/app/windows/capture/DesktopCaptureWindow.tsx)

### Screenshot selection appears stuck and later opens duplicate floating Composers

- Symptom:
  The first valid screenshot region remains on the full-screen selector for
  several seconds. Retrying the shortcut or selection eventually produces two
  compact capture windows.
- Quick checks:
  Correlate `screenshot shortcut activated`, `screenshot selection requested`,
  `screenshot composer presented`, and `screenshot composer metadata ready` by
  `captureId`. One selection request followed by a long
  `agent.composer_options.load` proves that pointer delivery succeeded and the
  native transition was incorrectly coupled to metadata. Two different IDs
  reaching presentation prove a cross-capture lifecycle race; repeated requests
  for one ID are an input single-flight failure. If the Composer appears only
  after Escape, verify that `composer presented` includes
  `fullscreenExit: "event"`; logging presentation before that native event is a
  false-positive lifecycle boundary.
- Root cause:
  The selector renderer waited for a selection IPC response, while Main waited
  for workspace-owned Agent metadata before leaving native full-screen. A user
  retry could create or revive another capture while the old asynchronous
  continuation had no active-window identity fence. Input coalescing alone
  cannot prevent that older continuation from presenting late. Independently,
  macOS simple-fullscreen exit is asynchronous: setting it to false and then
  immediately applying compact bounds leaves those bounds suppressed until the
  native transition completes, which an Escape key can accidentally trigger.
- Fix:
  Enter a compact preparing stage on the first valid pointer-up and perform the
  native full-screen-to-floating transition before awaiting metadata. Give each
  capture a unique ID, coalesce selection within that capture, reuse a visible
  active capture on repeated shortcuts, and require every asynchronous window
  continuation to prove it still owns the active live capture. Destroying or
  replacing a capture must invalidate that proof. On macOS, wait for the
  `leave-full-screen` event before applying compact bounds; do not treat the
  synchronous setter call or immediate fullscreen getter as completion.
- Validation:
  Defer composer metadata and assert that native presentation occurs first.
  Supersede the capture both during the native transition and while metadata is
  pending, and assert that neither path can continue. At runtime, one shortcut
  and one selection should log one ID in the order `selection requested` →
  `composer presented` → `composer metadata ready`, with presentation reporting
  `fullscreenExit: "event"` on macOS.
- References:
  [captureSelectionTransition.ts](../../../apps/desktop/src/main/capture/captureSelectionTransition.ts)
  [desktopCaptureService.ts](../../../apps/desktop/src/main/capture/desktopCaptureService.ts)
  [desktopCaptureWindowController.ts](../../../apps/desktop/src/renderer/src/app/windows/capture/desktopCaptureWindowController.ts)

### Frameless capture close action is inert and the next shortcut appears stuck

- Symptom:
  The floating capture Composer ignores its close button and Escape. A later
  global shortcut may focus nothing or appear to do no work.
- Quick checks:
  Inspect Electron app-region ownership around the close control and record
  keydown listeners in capture and bubble phases. Then inspect whether the main
  process marked the active capture `closing` without receiving `closed`.
- Root cause:
  Native drag-region hit testing can consume a descendant action before React,
  while portaled dropdowns can consume a bubble-phase Escape first. If
  cancellation then uses a preventable close path, the main process can retain
  a live window already marked as closing.
- Fix:
  Make the expanding title strip the drag region and keep close as a sibling
  no-drag action. Observe Escape at the window capture phase. Destroy the
  ephemeral capture BrowserWindow on cancellation, clear ownership from its
  `closed` event, and replace any closing, destroyed, or hidden window on the
  next shortcut.
- Validation:
  Verify close and Escape with model, Agent, project, and mention portals open,
  then invoke the global shortcut again and confirm a new capture window owns
  the request.
- References:
  [DesktopCaptureWindow.tsx](../../../apps/desktop/src/renderer/src/app/windows/capture/DesktopCaptureWindow.tsx)
  [desktopCaptureService.ts](../../../apps/desktop/src/main/capture/desktopCaptureService.ts)
