# Mobile Troubleshooting

## Android stays on “Syncing the latest data” after pairing

- **Symptom:** Device pairing and the direct DeviceLink handshake succeed, but
  the mobile App remains on **Syncing the latest data**. The native log repeats
  `Agent live stream rejected`, often once per retry interval.
- **Quick checks:** Correlate the pairing ID and workspace across the phone and
  computer logs. If DeviceLink reaches its connected stage and the Agent live
  rejection reports `protocol_revision_mismatch`, compare the safe
  `expectedRevision` and `receivedRevision` hashes. This is a protocol
  compatibility failure, not a local-network or pairing failure.
- **Root cause:** The computer rejects an Agent live subscription whose protocol
  revision does not match its own. If the native rejection is collapsed into a
  generic disconnect, the live lane treats a deterministic incompatibility as
  transient and retries forever. Repeated disconnect callbacks can also keep
  replacing the connection-ready deadline, so the App never reaches a visible
  failed state.
- **Fix:** Preserve the typed rejection reason and revision hashes through the
  native bridge. Classify `protocol_revision_mismatch` as terminal for the
  current connection attempt, close the rejected subscription without
  scheduling another live retry, and keep the original synchronization
  deadline for retryable transport failures. Present an explicit incompatible
  version message with a mobile update action; do not automatically restart a
  terminal attempt after foreground resume.
- **Validation:** Verify an ordinary stream close still retries and rebuilds
  DeviceLink after the recovery grace period. Inject a protocol-revision
  rejection and assert that the connection enters the failed state once, emits
  a `device_connection.phase_changed` diagnostic with stable
  `protocol_revision_mismatch`, preserves both revision hashes, schedules no
  additional subscription, and stays terminal across background and foreground
  transitions. Confirm the failure UI offers **Check for updates** instead of
  **Reconnect**.
- **References:** `apps/mobile/src/native/agentLiveNativeBridge.ts`,
  `apps/mobile/src/services/workspaceAgentLiveLane.ts`,
  `apps/mobile/src/services/mobileApplicationService.ts`,
  `apps/mobile/src/components/MobileConnectionRecoveryOverlay.tsx`

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
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/AppLifecycleModule.kt`,
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

## Android update stays on MainActivity without opening the installer

- **Symptom:** The Android App remains in the update progress overlay or never
  opens `PackageInstaller` / `.InstallStart`. A successful feed request does
  not prove that Android downloaded, verified, and handed off the APK.
- **Quick checks:** Filter the device logcat by the native update tag:

  ```sh
  adb -s <serial> logcat -v threadtime TuttiMobileSecurity:I '*:S'
  ```

  The UI phase narrows the boundary: **Preparing** means validation/storage,
  **Downloading** or **Paused** is Android `DownloadManager`, **Verifying** is
  exact-size plus SHA-256 verification, **Allow update installation** is the
  per-app unknown-source permission handoff, and **Install the downloaded
  update** is the Android package-installer handoff. Inspect the system-owned
  job with:

  ```sh
  adb -s <serial> shell dumpsys download
  ```

  `DownloadManager` owns network reconnection and background continuation. The
  App persists its download id and release metadata so reopening the App and
  choosing the same release reconnects to the job or reuses a verified cached
  APK. After verification it also records the target `versionCode`: a confirmed
  install deletes the APK immediately, while a process replacement during
  upgrade is handled on the next launch once the installed version reaches the
  target. Installer cancellation or failure retains the APK for retry. The
  in-App download cancel action removes the system job and cached artifact.

- **Relevant error codes:** `UPDATE_URL_INVALID`, `UPDATE_VERSION_INVALID`,
  `UPDATE_SIZE_INVALID`, `UPDATE_SIZE_MISMATCH`,
  `UPDATE_STORAGE_INSUFFICIENT`, `UPDATE_DOWNLOAD_FILE_FAILED`,
  `UPDATE_DOWNLOAD_SERVER_FAILED`, `UPDATE_DOWNLOAD_MANAGER_FAILED`,
  `UPDATE_DOWNLOAD_QUERY_FAILED`, `UPDATE_CHECKSUM_INVALID`,
  `UPDATE_CHECKSUM_FAILED`, `UPDATE_CACHE_FAILED`, `UPDATE_CACHE_REPLACE_FAILED`,
  `UPDATE_INSTALL_DEFERRED`, `UPDATE_INSTALL_STORAGE_INSUFFICIENT`,
  `UPDATE_INSTALL_INCOMPATIBLE`, `UPDATE_INSTALL_CONFLICT`,
  `UPDATE_INSTALL_BLOCKED`, `UPDATE_INSTALL_PACKAGE_INVALID`,
  `UPDATE_INSTALL_FAILED`, `UPDATE_URI_FAILED`, and
  `UPDATE_INSTALLER_LAUNCH_FAILED`. If Android's
  per-app unknown-source permission is missing, `UPDATE_INSTALL_PERMISSION_REQUIRED`
  means the user returned without granting it rather than an APK failure;
  `UPDATE_PERMISSION_SETTINGS_FAILED` means the system settings page itself
  could not be opened. The `EXTRA_RETURN_RESULT` flow reports the package
  manager result through `android.intent.extra.INSTALL_RESULT`; project that
  legacy result to the public `PackageInstaller` status before choosing the
  in-App error. A cancelled activity without an install result is user
  cancellation; an aborted or rejected result remains a failure.
- **Root cause:** The release feed, Android system download, artifact
  verification, FileProvider, and PackageInstaller are separate trust
  boundaries. A stale or malformed `sizeBytes`, a reused version URL with
  different bytes, insufficient storage, a paused system job, or missing
  unknown-source permission can stop the chain at different phases.
- **Fix:** Keep release URLs credential-free HTTPS and publish immutable APK
  paths under `<tag>/<sha256>/`. Preflight both the APK and checksum before
  uploading either object, then update `latest.json` last. Treat `latest.json`
  `sizeBytes` and `sha256` as mandatory: both must match before PackageInstaller
  opens. If the permission settings page opens, enable **Allow from this
  source** and return to the App; the verified cached APK continues to the
  installer automatically. Returning without granting permission produces a
  localized recovery prompt and keeps the package for an explicit retry. Keep
  the target version with that pending artifact, delete it on confirmed
  success, and repeat cleanup on the first launch whose installed
  `versionCode` reaches the target. For paused downloads, restore an allowed
  network or cancel and retry rather than deleting app data.
- **Validation:** Run `pnpm --filter @tutti-os/mobile check`,
  `./gradlew app:testDebugUnitTest`, and
  `./gradlew app:compileDebugKotlin` from `apps/mobile/android`. On a physical
  device, reproduce from Settings and verify determinate progress, cancel,
  background/reopen continuation, offline pause/resume, exact-size/SHA failure,
  and the installer handoff. Confirm that a late progress callback after cancel
  cannot reopen the overlay. For permission recovery, revoke Tutti's
  unknown-source permission, finish the download, grant the permission in
  Android settings, return to the App, and confirm the installer opens without
  another download action. Also deny the permission once and confirm the App
  explains how to recover. Exercise an installer rejection and confirm it is
  reported with the mapped failure rather than cancellation. Cancel once and
  confirm the verified APK remains reusable; complete an update and confirm
  the pending APK is gone either from the success callback or after the updated
  App starts. For release recovery, simulate an APK-only upload, rerun the same
  version with a different APK digest, and confirm the missing objects are
  published before `latest.json` moves.
- **References:**
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MobileSecurityModule.kt`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MobileUpdateArtifact.kt`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MobileUpdateCoordinator.kt`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MobileUpdateInstallResult.kt`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MobileUpdatePendingInstallStore.kt`,
  `apps/mobile/src/services/mobileUpdateService.ts`,
  `tools/scripts/build-mobile-release-latest.mjs`

## Mobile quick prompts are missing from the plus menu

- **Symptom:** The connected Mobile composer does not show Quick prompts under
  `+`, or the list is empty despite prompts saved on Desktop.
- **Quick checks:** Inspect the DeviceLink `agent_http` response for
  `GET /v1/agent-quick-prompts`. A 403 response with `route_not_allowed`
  identifies an allowlist gap.
- **Root cause:** Mobile loads prompt content only from the canonical device
  list, so neither the UI nor workspace activity state invents a local
  fallback.
- **Fix:** Keep the exact quick-prompt GET route in the DeviceLink allowlist
  and keep all preference writes, quick-prompt mutations, and per-prompt
  routes blocked. Refresh the authenticated-device quick-prompt service when
  the `+` menu opens.
- **Validation:** Confirm the canonical prompt order is visible, search
  matches title and content, and selecting a prompt adds text at the current
  input position without replacing the existing draft or sending it.
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

## Browser login completes but leaves the browser in front

- **Symptom:** Mobile completes provider login, but the browser stays in front.
  Switching back to Tutti manually reveals that the account session is already
  available or allows the login flow to finish.
- **Quick checks:** Confirm the localhost callback received a transfer code and
  that transfer-code redemption succeeds. If the hosted result page's manual
  “open App” action works, the account flow is healthy and only the browser-to-App
  return path failed.
- **Root cause:** Opening a raw external browser makes the hosted result page
  responsible for returning to `tutti://auth/login`. Mobile browsers can reject
  a custom-scheme navigation started by delayed JavaScript because it no longer
  carries a direct user gesture, even though the localhost bridge already
  completed the account transfer.
- **Fix:** Keep the shared hosted login page, localhost bridge, and one-time
  transfer-code redemption. Present that flow with `ASWebAuthenticationSession`
  on iOS and AndroidX Auth Tab when the Android browser provider supports it, so
  the operating system owns callback matching and foreground return. Android
  falls back to the external system browser when Auth Tab is unavailable; the
  hosted manual return action remains the recovery path for that fallback.
- **Validation:** On physical iOS and Android devices, complete a real provider
  login and confirm the browser dismisses and Tutti becomes foreground without
  a manual app switch. Also cancel once, exercise an Android browser without Auth
  Tab support, and verify the transfer code is redeemed no more than once.
- **References:** `apps/mobile/ios/TuttiMobile/MobileWebAuthenticationSession.swift`,
  `apps/mobile/ios/TuttiMobile/MobileBrowserAuthBridge.swift`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MainActivity.kt`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MobileBrowserAuthBridge.kt`

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
- **Validation:** Complete a real browser login, verify the App reaches the
  device page, restart the App, and verify the same account session still
  authorizes device-list requests.
- **References:** `apps/mobile/src/services/accountClient.ts`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/MobileSecurityModule.kt`

## Android DeviceLink opens a session and then repeatedly restarts

- **Symptom:** Pairing and the secure link succeed, and the App may briefly load
  a workspace or session before returning to the launcher. Android process exit
  history reports `EXIT_SELF` with status `2`; logcat contains
  `fatal error: bulkBarrierPreWrite: unaligned arguments` instead of a Java or
  React Native exception.
- **Quick checks:** Run `adb shell dumpsys activity exit-info
sh.tutti.mobile` and inspect a narrow logcat window for the Go fatal message.
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
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/DeviceLinkModule.kt`

## Mobile direct DeviceLink consistently takes about ten seconds

- **Symptom:** A paired computer is online and often on the same LAN, but the
  direct path regularly needs roughly ten seconds before it becomes usable.
  Relay may appear much faster even though P2P eventually succeeds.
- **Quick checks:** Inspect sanitized `device_link.stage` events for
  `direct_credentials_ready`, `direct_attempt_created`,
  `direct_first_candidate_published`, `direct_attempt_ready`,
  `direct_remote_candidate_received`, and `direct_connected`. If credentials
  or attempt creation appear only after a five-second boundary, inspect the
  native prepare bridge for a blocking full ICE description. If ready is early
  but connected is late, isolate candidate exchange from authenticated
  ICE/QUIC instead of changing Relay delay.
- **Root cause:** The caller previously waited for a complete host-only ICE
  description, created the attempt to discover server STUN endpoints, replaced
  the Participant, and then waited for a second complete description. The
  Desktop owner also waited for its full description before publishing. Two
  configured five-second gathering windows therefore sat on the critical path,
  while TSH's lower-level implementation already published credentials and
  trickled candidates during `Connect`.
- **Fix:** Use `candidateexchange.Start` and publish valid ICE credentials
  immediately, allowing an empty candidate list. Run `PublishLocal` and
  `FeedRemote` beside `Participant.Connect`; keep signed attempt reads/writes,
  push hints, account authorization, and pairing state in the product adapter.
  Mobile must drain the gomobile `ActionPump` next/resolve protocol rather than
  use the legacy blocking `LocalDescription` bridge or own a second TypeScript
  retry/poll scheduler. Resolve a publication successfully only after the
  returned authoritative attempt contains its candidate snapshot. Android must
  keep enough native operation workers for `Connect`, candidate actions, and
  Relay work to progress concurrently.
- **Validation:** Cover an initial zero-candidate snapshot, a later local
  candidate update, a ready peer with zero candidates, a later authoritative
  remote snapshot, missed-push polling fallback, exact-snapshot publish retry,
  and a successful stream probe. Compare stage deltas on LAN and external NAT;
  do not log candidates, addresses, ICE credentials, fingerprints, tokens, or
  payloads.
- **References:** `packages/device-link/candidateexchange`,
  `packages/device-link/mobile/link.go`,
  `apps/mobile/src/services/deviceLinkCandidateExchange.ts`,
  `services/tuttid/service/mobileremote/candidate_exchange.go`

## Mobile shows output from a completed Session after foreground resume

- **Symptom:** After the App enters the background and is reopened, transcript
  output from the previously selected Session continues streaming even though
  that Session already ended on the host.
- **Quick checks:** Compare App lifecycle events with Native `TuttiDeviceLink`
  Agent Live logs. Capture the subscription generation on the last delivery
  before background and the first delivery after foreground. If a delivery from
  the closed generation reaches the replacement JavaScript listener, the fault
  is lifecycle fencing rather than canonical Session state or server replay.
- **Root cause:** DeviceLink intentionally stays open for a short background
  grace period, but Agent Live used to share that lifetime. A suspended
  JavaScript runtime could therefore miss or delay its stop call while Native
  continued reading the old stream. React Native could queue those deliveries
  and publish them to the newly attached listener after foreground resume. The
  Native envelope carried workspace identity but no local subscription
  generation, so the replacement listener could not distinguish queued old
  output from its new stream.
- **Fix:** Stop Agent Live immediately at the Android and iOS background
  boundary while preserving the underlying DeviceLink grace interval. Give
  every bridge subscription a caller-owned generation, include it in every
  Native delivery, and reject mismatched generations in both the bridge parser
  and workspace live lane. Queue canonical workspace and selected-Session
  reconciliation before opening the replacement stream.
- **Validation:** Background and foreground a connected workspace, invoke a
  captured old listener after the replacement subscription exists, and verify
  it cannot mark transport connected or change projected activity. Verify
  matching-generation ready and event deliveries still apply, missing or stale
  generations fail closed, and Android/iOS Native binding checks pass.
- **References:**
  `apps/mobile/src/native/createMobileServicePorts.ts`,
  `apps/mobile/src/services/workspaceAgentLiveLane.ts`,
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/DeviceLinkModule.kt`,
  `apps/mobile/ios/TuttiMobile/DeviceLinkModule.mm`

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
  `apps/mobile/android/app/src/main/java/sh/tutti/mobile/DeviceLinkModule.kt`

## iOS App crashes after loading the JavaScript bundle

- **Symptom:** A physical iOS device downloads or evaluates the React Native
  bundle, then the App exits with `SIGSEGV`. The crash report points at
  `objc_retain` or `objc_storeStrong` below
  `ObjCTurboModule::performMethodInvocation` on the JavaScript thread.
- **Quick checks:** Capture the App console and the latest `.ips` crash report.
  If the last log is JavaScript bundle evaluation and the faulting stack is a
  synchronous Objective-C TurboModule invocation, inspect every blocking
  synchronous Swift export used during startup before investigating Metro or
  DeviceLink.
- **Root cause:** React Native's Objective-C interoperability path expects an
  object from a blocking synchronous method. Exporting a Swift method with a
  primitive `Bool` return can leave the invocation result buffer shaped like an
  object pointer; retaining that value then causes an invalid-address crash.
- **Fix:** Return `NSNumber` from the Swift export. React Native converts it to
  a JavaScript boolean, so the TypeScript contract remains `boolean`.
- **Validation:** Build and sign the physical-device target, install it, launch
  it with the device console attached, and keep the process alive beyond the
  previous post-bundle crash window. Confirm the initial lifecycle state still
  arrives as a JavaScript boolean.
- **References:** `apps/mobile/ios/TuttiMobile/AppLifecycleModule.swift`,
  `apps/mobile/ios/TuttiMobile/MobileNativeModules.m`,
  `apps/mobile/src/native/appLifecyclePort.ts`

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
