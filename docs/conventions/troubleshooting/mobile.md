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
