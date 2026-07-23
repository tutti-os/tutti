# Mobile Troubleshooting

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
- **Root cause:** A gomobile-exported Go method returned `([]byte, error)`.
  Generated cgo code moves the pointer-bearing return values through a packed
  result structure; its address is not guaranteed to satisfy the Go runtime
  write barrier's pointer alignment. The first successful response-body read
  therefore exposed the upstream cgo alignment defect. Returning final data
  together with `io.EOF` also cannot be represented by the generated Java API,
  which chooses either a byte array or an exception.
- **Fix:** Keep bulk stream data in a Java-owned byte array passed into Go and
  return only a scalar byte count from the gomobile method. A positive count
  takes precedence when the underlying Go reader returns data together with
  `io.EOF`; zero or a negative count is a failed incomplete frame. Do not change
  this boundary back to a Go slice-plus-error return while the repository uses a
  Go toolchain affected by
  [golang/go#46893](https://github.com/golang/go/issues/46893).
- **Validation:** Generate the Java binding and confirm the stream method is
  `readInto(byte[])` with a scalar return, run the mobile DeviceLink tests, build
  and install the AAR consumer, load a real session on an ARM64 Android device,
  and observe beyond the previous crash window with no new Go fatal message.
- **References:** `packages/device-link/mobile/link.go`,
  `apps/mobile/android/app/src/main/java/dev/tutti/mobile/DeviceLinkModule.kt`
