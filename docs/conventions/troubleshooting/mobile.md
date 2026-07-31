# Mobile Troubleshooting

## Android QR scan closes without advancing pairing

- **Symptom:** The pairing scanner opens, reads a valid Desktop QR code, and
  returns to the device page, but the App neither shows an error nor advances
  to waiting or confirmed state.
- **Quick checks:** Confirm Android launches and finishes the ZXing
  `CaptureActivity`, then inspect events from `TuttiAppLifecycle`. A background
  event during the in-process Activity handoff identifies a lifecycle-adapter
  regression rather than a camera or QR parsing failure.
- **Root cause:** Android presents the scanner as a child Activity. Pausing the
  React Activity therefore looks like ordinary App backgrounding. If the
  service invalidates every pairing generation on that transition, the native
  scan promise can resolve successfully while its QR payload is silently
  discarded as stale.
- **Fix:** Own application visibility at the native platform boundary. Android
  publishes `ProcessLifecycleOwner` state, so switching between Activities in
  the same process remains foreground; iOS publishes `UIApplication`
  foreground/background notifications. The TypeScript lifecycle port consumes
  this one semantic signal, while pairing remains unaware of Activities and
  scanners. A genuine process background suspends remote pairing operations
  and starts the DeviceLink grace period. A claim already sent is reconciled
  from challenge state after foreground recovery instead of being submitted
  twice.
- **Validation:** Verify the lifecycle adapter publishes its initial state,
  deduplicates transitions, and disposes subscriptions. Verify the application
  service applies background policy only after a real process background event.
  Verify scanner cancellation, duplicate taps, permission failures, and
  claim/poll reconciliation in the device service. Finally scan on Android and
  confirm no background event is emitted during the
  `MainActivity -> CaptureActivity -> MainActivity` sequence.
- **References:**
  `apps/mobile/android/app/src/main/java/dev/tutti/mobile/AppLifecycleModule.kt`,
  `apps/mobile/ios/TuttiMobile/AppLifecycleModule.swift`,
  `apps/mobile/src/native/appLifecyclePort.ts`

## Android release bundling cannot resolve the JSX transform

- **Symptom:** `app:assembleRelease` reaches Metro bundling and fails
  `app:createBundleReleaseJsAndAssets` with `Cannot find module
'@babel/plugin-transform-react-jsx'`, while TypeScript, Jest, and debug
  development may still pass.
- **Quick checks:** Resolve `@babel/plugin-transform-react-jsx` from the
  `apps/mobile` package, then run a production Android Metro bundle. If
  resolution fails from the app but the plugin exists only below the React
  Native preset in pnpm's store, the app has been relying on transitive layout.
- **Root cause:** `react-native-css-interop` asks Babel to load the JSX
  transform by package name but does not declare that package. pnpm's strict
  dependency isolation therefore does not expose the preset's private copy to
  the app-level Babel configuration.
- **Fix:** Keep `@babel/plugin-transform-react-jsx` as an explicit
  `apps/mobile` development dependency aligned with the locked Babel cohort.
  Do not solve this by changing pnpm hoisting.
- **Validation:** Resolve the plugin from `apps/mobile`, produce a
  `--dev false` Android Metro bundle, and run the `Android Internal Build`
  workflow through APK assembly.
- **References:** `apps/mobile/package.json`, `apps/mobile/babel.config.js`

## Mobile quick prompts are missing from the plus menu

- **Symptom:** The Desktop quick-prompt library is enabled and contains
  prompts, but the connected Mobile composer does not show Quick prompts under
  `+`.
- **Quick checks:** Read the host's Desktop preferences and confirm
  `agent.quickPromptLibrary` is `true`. Then inspect the DeviceLink
  `agent_http` responses for `GET /v1/preferences/desktop` and
  `GET /v1/agent-quick-prompts`. A 403 response with `route_not_allowed`
  identifies an allowlist gap.
- **Root cause:** Mobile deliberately fails closed when it cannot verify the
  Desktop feature gate. It also loads prompt content only from the canonical
  device list, so neither the UI nor workspace activity state invents a local
  fallback.
- **Fix:** Keep the two exact GET routes in the DeviceLink allowlist and keep
  all preference writes, quick-prompt mutations, and per-prompt routes blocked.
  Refresh the authenticated-device quick-prompt service when the `+` menu
  opens.
- **Validation:** Confirm a disabled or missing feature flag hides the row,
  enabling it exposes the canonical prompt order, search matches title and
  content, and selecting a prompt adds text at the current input position
  without replacing the existing draft or sending it.
- **References:** `services/tuttid/service/mobileremote/remote_protocol.go`,
  `apps/mobile/src/services/mobileQuickPromptLibraryService.ts`,
  `apps/mobile/src/components/MobileComposerDock.tsx`

## Mobile composer model and permission controls are missing

- **Symptom:** A remotely connected Android or iOS App can open an Agent
  conversation and send prompts, but the model and permission controls above
  the composer are absent.
- **Quick checks:** Query the host with
  `tutti --json agent composer-options --agent-id <agent-target-id>` and confirm
  that model and permission options are present. Then inspect the DeviceLink
  `agent_http` response for the matching
  `POST /v1/agent-providers/{provider}/composer-options` request. A 403 response
  with `route_not_allowed` identifies a transport allowlist gap rather than an
  AgentGUI capability or mobile layout problem.
- **Locale check:** Confirm the request body includes the phone's normalized
  `locale` (`en` or `zh-CN`). If it is absent, tuttid falls back to the desktop
  preference and the phone may show model, reasoning, or permission labels in
  the desktop language.
- **Root cause:** Mobile loads authoritative composer options through the
  DeviceLink HTTP bridge. If the exact read-side composer-options route is
  absent from the bridge allowlist, the request is rejected before it reaches
  tuttid's handler. The mobile UI fails closed and hides controls for options it
  cannot verify.
- **Fix:** Add only the exact `POST
/v1/agent-providers/{provider}/composer-options` shape to the DeviceLink
  `agent_http` allowlist, and include the mobile device locale in the request.
  Keep unrelated provider routes and other HTTP methods blocked; do not
  hardcode model or permission catalogs in the App.
- **Validation:** Run the focused `mobileremote` tests, confirm a composer-options
  request round-trips through DeviceLink while GET and extra-path variants
  remain forbidden, then use different phone and desktop languages to verify
  that option labels follow the phone language and that model, reasoning, and
  permission changes update the chips and persist in the selected Session.
- **References:** `services/tuttid/service/mobileremote/remote_protocol.go`,
  `apps/mobile/src/services/workspaceActivityCommandAdapter.ts`,
  `apps/mobile/src/components/MobileComposerSettingsSheet.tsx`

## Mobile composer option sheets do not respond

- **Symptom:** Model, reasoning, speed, and permission chips are visible and
  accessible above the composer, but tapping them does not show their option
  sheet; or rapidly alternating between a chip and the `+` button leaves two
  overlapping menus, with the lower menu visible but unable to receive taps.
- **Quick checks:** Tap a chip on a real Android or iOS renderer and inspect the
  JavaScript log. Repeated `BottomSheetModal::handlePortalRender` entries,
  followed by a maximum-update-depth error, identify the legacy overlay path.
  Without that error, inspect the native window hierarchy: two simultaneous
  composer `Modal` windows identify competing local overlay state rather than
  a slow or missing press handler. A missing composer-options response is a
  different problem covered above.
- **Root causes:** `@gorhom/bottom-sheet` delegates `BottomSheetModal` rendering
  through `@gorhom/portal`; its portal update path is incompatible with the
  current React 19 Native renderer and recursively republishes the modal node
  instead of presenting it. Separately, sibling composer controls must not own
  independent window-level overlay state: queued taps can open both windows,
  and the top window then intercepts input intended for the visible lower one.
- **Fix:** Keep the shared compact `NativeSheet` on React Native's window-level
  `Modal`, with UI System scrim and panel tokens. Require a caller-localized
  close label, expose backdrop dismissal as an accessibility button, handle the
  iOS accessibility escape gesture, and represent an optional fixed height as
  one value rather than silently accepting multiple snap points. Reserve
  `@gorhom/bottom-sheet` for app-owned complex sheets that genuinely need its
  gesture, keyboard, or multi-snap-point behavior. At composition boundaries
  that offer multiple overlay entry points, keep one discriminated overlay
  state in their nearest common owner and make child controls submit typed menu
  intents.
- **Validation:** Open and dismiss the model, speed, and permission sheets more
  than once, select the already active option without changing Session state,
  and rapidly alternate between a settings chip and `+`; assert that no more
  than one native modal is visible. Confirm there is no maximum-update-depth
  error. Also verify touch backdrop, Android system-back, VoiceOver escape, and
  screen-reader close button dismissal without hiding the sheet's interactive
  descendants.
- **References:** `packages/ui/system/src/native/sheet.tsx`,
  `apps/mobile/src/components/MobileComposerDock.tsx`,
  `apps/mobile/src/components/MobileComposerSettingsSheet.tsx`

## Browser login returns to the App but remains signed out

- **Symptom:** Android opens the Tutti Web login page, completes the provider
  login, and returns to the App, but the login screen shows a generic failure.
- **Quick checks:** Confirm the localhost auth bridge has stopped listening after
  the callback. In read-only account-service access logs, compare the transfer
  code redemption with the immediately following `user/v1/user_info` request. A
  successful redemption followed by `SESSION_ID_MISSING` identifies this case.
- **Root cause:** Mobile API requests already authenticate from the encrypted
  session using one explicit `Cookie` header. Leaving React Native's native
  cookie jar enabled creates a second credential source; a stale native
  `session_id` can be appended to or override the explicit session after browser
  login.
- **Fix:** Keep the account session in encrypted native storage, set
  `credentials: "omit"` on account and control-plane fetches, and attach exactly
  one validated `session_id` header per API request. The system browser login
  bridge returns only a short-lived transfer code; do not copy provider or
  browser cookies into the App, and do not make API login depend on a WebView
  cookie store. During migration, clear the legacy native `session_id` cookie
  at startup and sign-out, but keep cookie installation outside the application
  port contract.
- **Validation:** Complete a real system-browser login, verify the App reaches the
  device page, restart the App, and verify the same account session still
  authorizes device-list requests.
- **References:** `apps/mobile/src/services/accountClient.ts`,
  `apps/mobile/android/app/src/main/java/dev/tutti/mobile/MobileSecurityModule.kt`

## Android DeviceLink opens a session and then repeatedly restarts

- **Symptom:** Pairing and the secure link succeed, and the App may briefly load
  a workspace or session before returning to the launcher. Android process exit
  history reports `EXIT_SELF` with status `2`; logcat contains
  `fatal error: bulkBarrierPreWrite: unaligned arguments` instead of a Java or
  React Native exception.
- **Quick checks:** Run `adb shell dumpsys activity exit-info
dev.tutti.mobile` and inspect a narrow logcat window for the Go fatal message.
  This distinguishes a Go runtime abort from an Android lifecycle transition or
  a React Native development reload.
- **Root cause:** A gomobile-exported Go method returned a pointer-bearing value,
  first `([]byte, error)` and later `(string, error)` from Agent Live's
  `Subscriber.Apply`. Generated cgo code moves pointer-bearing parameters and
  return values through a packed structure whose address is not guaranteed to
  satisfy the Go runtime write barrier's pointer alignment before Go 1.26. The
  first successful response-body or Agent Live frame therefore exposes the
  upstream cgo alignment defect. Returning final stream data together with
  `io.EOF` also cannot be represented by the generated Java API, which chooses
  either a byte array or an exception.
- **Fix:** Build every Android AAR and iOS XCFramework gomobile artifact with
  Go 1.26.0 or newer, which includes the
  [cmd/cgo alignment fix](https://github.com/golang/go/commit/d5b950399de01a0e28eeb48d2c8474db4aad0e8a).
  Keep bulk stream data in a Java-owned byte array passed into Go and return only
  a scalar byte count so final bytes plus `io.EOF` remain representable. The
  Mobile and DeviceLink Makefiles pin the fixed toolchain; do not bypass that pin
  when rebuilding native artifacts.
- **Validation:** Generate the Java binding and confirm the stream method is
  `readInto(byte[])` with a scalar return, build the AAR and confirm every
  `libgojni.so` reports the pinned Go toolchain, then install the AAR consumer,
  connect on an ARM64 Android device, receive Agent Live frames, and observe
  beyond the previous crash window with no new Go fatal message.
- **References:** `packages/device-link/mobile/link.go`,
  `apps/mobile/android/app/src/main/java/dev/tutti/mobile/DeviceLinkModule.kt`

## Mobile stays connected after a long lock-screen interval but sends fail

- **Symptom:** After Mobile remains locked or backgrounded for at least the
  DeviceLink grace interval, the previous conversation is still visible but the
  next command fails. Returning to the computer list and connecting again
  restores service.
- **Quick checks:** Compare `application.lifecycle_changed` and
  `device_connection.phase_changed` diagnostics with Native `TuttiDeviceLink`
  logs. If Native closed the link after its grace deadline while JavaScript
  never published its own delayed disconnect, verify whether the foreground
  transition used elapsed background time. Confirm the workspace runtime is
  blocked until a replacement live lane reports ready.
- **Root cause:** Native lifecycle handlers continue running while React Native
  timers may be suspended. When both layers independently scheduled the same
  background deadline, Native closed the real link but JavaScript canceled its
  still pending timer on foreground and resumed a stale connected workspace.
- **Fix:** Keep the close deadline Native-owned. Record background entry time in
  the application service and decide short resume versus full reconnect from
  elapsed time on foreground. Project one application-scoped connection phase,
  retain the paused workspace until a hydrated replacement is ready, and let a
  root overlay render that phase without owning recovery logic.
- **Validation:** Cover foreground before and after the grace boundary, an
  active live-stream loss, failed reconnect plus explicit retry, and generation
  fencing when the app backgrounds during recovery. On a physical device, lock
  beyond the deadline, unlock, observe reconnect/synchronize presentation, and
  send from the original conversation without revisiting the computer list.
- **References:**
  `apps/mobile/src/services/mobileApplicationService.ts`,
  `apps/mobile/android/app/src/main/java/dev/tutti/mobile/DeviceLinkModule.kt`

## iOS pod install intermittently reports pathname contains null byte

- **Symptom:** `pnpm --filter @tutti-os/mobile ios:pods` downloads and installs
  every Pod, then fails during `Generating Pods project` with
  `ArgumentError: pathname contains null byte` from
  `Pod::Project#group_for_path_in_group`. Re-running may succeed.
- **Quick checks:** Confirm the stack ends in `Pathname#realdirpath` and the
  workspace uses pnpm-linked React Native packages. CocoaPods version changes or
  deleting `Pods/` may change the frequency but do not identify a durable fix.
- **Root cause:** CocoaPods preserves the filesystem layout for local Pods and
  resolves their common base path through `realdirpath`. That resolution is
  intermittently unsafe for pnpm-backed local Pod symlinks while the Pods
  project is generated.
- **Fix:** Keep `apps/mobile/ios/cocoapods_pathname_workaround.rb` loaded from
  the Podfile. It retains CocoaPods' group-building behavior but normalizes the
  local Pod base with `cleanpath` instead of resolving the pnpm symlink through
  `realdirpath`. Do not depend on retries or a CocoaPods downgrade.
- **Validation:** Run `ios:pods` from a clean checkout, confirm the Pods project
  is generated, then archive the `TuttiMobile` workspace on the GitHub macOS 26
  runner to exercise the same pnpm and CocoaPods path.
- **References:** `apps/mobile/ios/Podfile`,
  `apps/mobile/ios/cocoapods_pathname_workaround.rb`,
  [CocoaPods #12798](https://github.com/CocoaPods/CocoaPods/issues/12798)

## Mobile Jest discovers tests inside iOS Pods

- **Symptom:** `pnpm --filter @tutti-os/mobile test` starts hundreds of Hermes
  or third-party suites under `apps/mobile/ios/Pods` after Pods are installed.
  Project suites may pass, but the command fails on upstream fixtures, Flow
  syntax, or snapshots.
- **Quick checks:** Inspect the failing test paths. Paths below `ios/Pods`
  identify test discovery crossing into CocoaPods output rather than a product
  test failure.
- **Root cause:** Jest recursively searches the package root. CocoaPods can
  vendor JavaScript sources and tests, and generated native dependency
  directories are not excluded by the default React Native preset.
- **Fix:** Keep `/ios/Pods/` in the Mobile Jest `testPathIgnorePatterns`,
  alongside the Android generated tree and `node_modules`. Do not adjust Babel
  transforms to make vendored test suites run.
- **Validation:** Install iOS Pods, run the Mobile test command, and confirm
  Jest discovers only repository-owned suites.
- **References:** `apps/mobile/jest.config.js`

## React Native Pressable rows stack their children vertically

- **Symptom:** A Native button, list row, or app-owned tappable row declares
  `flexDirection: "row"` but its icon, label, count, or trailing action appears
  vertically stacked on a Fabric Android device. Plain `View` rows on the same
  screen remain horizontal.
- **Quick checks:** Inspect the real device rather than relying only on
  TypeScript or snapshots. Compare the bounds from `uiautomator dump` for the
  direct children of the `Pressable`; consecutive vertical bounds identify the
  failure even when the parent style contains the expected row declaration.
- **Root cause:** In the current React Native NativeWind/CSS interop renderer,
  layout declarations on the `Pressable` host are not reliable for arranging
  its direct children. Interaction, surface, size, and pressed-state styles
  still apply, which makes this easy to mistake for stale Fast Refresh state.
- **Fix:** Keep interaction and surface styling on `Pressable`, but wrap its
  visual children in a plain token-backed `View` that owns
  `flexDirection: "row"` and alignment. Shared buttons and list rows should fix
  this once in `@tutti-os/ui-system/native`; app-specific tappable rows should
  follow the same inner-layout pattern.
- **Validation:** Perform a full JavaScript reload, then verify on Android that
  button icon/label, list title/trailing action, and section label/count remain
  horizontal. Confirm touch and accessibility actions still reach the outer
  `Pressable`.
- **References:** `packages/ui/system/src/native/button.tsx`,
  `packages/ui/system/src/native/list-row.tsx`
