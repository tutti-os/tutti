# Mobile Troubleshooting

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

## Mobile composer option chips do not open

- **Symptom:** Model, reasoning, speed, and permission chips are visible and
  accessible above the composer, but tapping them does not show their option
  sheet. The same model or permission options remain reachable through the `+`
  menu.
- **Quick checks:** Tap a chip on a real Android or iOS renderer and inspect the
  JavaScript log. Repeated `BottomSheetModal::handlePortalRender` entries,
  followed by a maximum-update-depth error, identify the overlay path; a
  missing composer-options response is a different problem covered above.
- **Root cause:** `@gorhom/bottom-sheet` delegates `BottomSheetModal` rendering
  through `@gorhom/portal`. Its portal update path is incompatible with the
  current React 19 Native renderer and recursively republishes the modal node
  instead of presenting it.
- **Fix:** Keep the shared compact `NativeSheet` on React Native's window-level
  `Modal`, with UI System scrim and panel tokens. Reserve
  `@gorhom/bottom-sheet` for app-owned complex sheets that genuinely need its
  gesture, keyboard, or multi-snap-point behavior.
- **Validation:** Open and dismiss the model, speed, and permission sheets more
  than once, select the already active option without changing Session state,
  and confirm there is no maximum-update-depth error. Also verify backdrop and
  Android system-back dismissal.
- **References:** `packages/ui/system/src/native/sheet.tsx`,
  `apps/mobile/src/components/MobileComposerSettingsSheet.tsx`

## Browser login returns to the App but remains signed out

- **Symptom:** Android opens the Tutti Web login page, completes the provider
  login, and returns to the App, but the login screen shows a generic failure.
- **Quick checks:** Confirm the localhost auth bridge has stopped listening after
  the callback. In read-only account-service access logs, compare the transfer
  code redemption with the immediately following `user/v1/user_info` request. A
  successful redemption followed by `SESSION_ID_MISSING` identifies this case.
- **Root cause:** React Native Android networking uses its native
  `ForwardingCookieHandler` and WebView `CookieManager`. A JavaScript `Cookie`
  request header is not sufficient to seed that cookie jar after the desktop
  transfer-code endpoint returns a session id in JSON.
- **Fix:** Install the redeemed `session_id` into the native cookie store before
  requesting account information. Reinstall it from encrypted session storage
  during App startup, and expire it on sign-out. Do not move provider credentials
  or browser cookies through JavaScript.
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
