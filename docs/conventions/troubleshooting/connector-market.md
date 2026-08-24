# Connector Market Troubleshooting

### Device code is missed when authorization moves focus to the browser

**Symptoms**

- the Connector authorization dialog enters a pending state, but the user does
  not see the device code before the browser gains focus
- reopening the desktop makes the code visible in the existing dialog
- the authorization operation and broker session are healthy

**Check**

Confirm the broker result contains a `device_code` Authorization View and the
renderer stores that View under the current Connector dialog. Then distinguish
the View transition from its explicit `activate` event: receiving the View must
not invoke the host's external-navigation callback.

**Rule**

Keep device-code authorization in the existing dialog. Receiving the View only
renders its code; the user-owned `activate` action opens the verification URL.
Continue to auto-open ordinary `external_link` Views, whose URL is itself the
next authorization step.

### A second authorize click starts another OAuth session

**Symptoms**

- the first Authorize click already opened the provider tab
- a second click, Continue, or dialog dismiss-and-reopen starts
  `replace_active` and tombstones the first session
- the first Google or provider tab later returns an empty 403 after Complete
  already succeeded for the replacement session
- the authorization button looks clickable again while the renderer Promise is
  still waiting

**Check**

Trace the renderer Promise separately from the Host Start. While
`authorizationInFlight` is set and the attempt is not canceled, a second
`beginAuthorization` must return that Promise and must not increment Host
starts. The dialog Authorize control stays disabled on
`actionWaitingAuthorization`; browser OAuth must not swap that control for
Continue when Start returns a synthesized `external_link` view. Cancel and the
authorization dialog's close button both end the round. After either action, the
next Authorize may send `replacementPolicy=replace_active` with a new
`clientRequestId`. Continuation polling inside the same action still reuses one
identity. Do not re-relay a provider `code` after Complete.

**Rule**

One user authorization action stays active until it completes or the user
Cancels. A second click is not a new user action. Keep the account projection
as durable authorization truth, and keep `pending` only in the Start command
result so shared clients continue that idempotent session. `replace_active` is
for an explicit new round after Cancel or after the previous action finished,
not for a repeated Authorize while the first Promise is still live. Do not
cancel the in-flight renderer Promise just because the user clicked again.

### OAuth finishes in the browser but does not return to the initiating desktop build

**Symptoms**

- the authorization result page renders and its return link uses a valid desktop scheme
- a development build started the flow, but the link targets the production scheme
- the result page host is `tutti.sh`, so deriving the desktop environment from the web host selects the wrong application

**Check**

Inspect the server-owned authorization bridge URL before it leaves the renderer. It must carry both the client identity and an exact `openAppUrl` for the initiating build, such as `tutti-dev://open`. Confirm the web transition page stores that value before navigating to the provider and that the result page uses the same sanitized value for both automatic navigation and the manual link.

**Rule**

The initiating desktop build owns the callback environment. Do not infer a production or development desktop scheme from the authorization website hostname. Web code must accept only the exact supported `open` routes and keep the legacy client marker solely as compatibility for already released clients.

### Composer install stays spinning on an OAuth remote connector

**Symptoms**

- composer connector menu “install” keeps a spinner for minutes
- daemon logs repeat `list connector MCP tools: MCP Streamable HTTP request failed: status 428`
- the install operation stays `running` with rising `attempt` and retryable `connector_install_failed`
- after enough retries the connector may still become `installed` while the account projection is `expired` and runtime desired is disabled

**Check**

Separate device installation from account authorization. Confirm the connector is remote Streamable HTTP plus oauth2, and that enabled runtime reconcile called `tools/list` before any user authorization. The composer trigger waits for the durable install operation, not for an enabled Agent route. `awaitRuntimeDesired` must be able to converge a disabled generation after an authorization-required observation.

**Rule**

HTTP 428 and JSON-RPC `-33001`/`-33002` are authorization-required, not retryable install failure. Persist an expired account projection, replan `RuntimeDesired` enabled=false, and complete install once that inactive generation is Observed. Do not keep the install operation retrying 428, and do not require a connected route before installation may become a device fact.

### API-key Connect toast fails while the token is still in the form

**Symptoms**

- Settings or composer Connect for an API-key connector such as Cloudflare shows `无法启动授权，请重试`
- the token field still contains the submitted secret
- tuttid logs `connector authorization could not be started` wrapping either `requires a valid secret` or a control-plane status
- HTTP `POST .../authorization:start` returns 503, often with a request body that already includes `secret`

**Check**

Inspect the SQLite `start_authorization` row and tuttid logs together.

- `attempt >= 2` plus a lease, and the wrapped cause is `connector authorization requires a valid secret`: the 500 ms durable-operation scanner replayed the command without the secret. `BeginAuthorization` keeps the secret only in the command and must not schedule `start_authorization`. Daemon bootstrap must fail leftover accepted or running `start_authorization` rows instead of replaying them.
- `attempt = 1`, no lease, and no `connector market operation failed` line: the live command reached the control plane with the submitted secret. Read the wrapped cause on `connector authorization could not be started` in tuttid.log and in the HTTP 503 `message`. `Post https://api.tutti.sh/...: EOF` is a transport failure before Composio sees the token. Check Clash/mihomo service logs at the same timestamp: if `tuttid --> api.tutti.sh` matches the final MATCH/漏网之鱼 rule and dials timeout, the request never reached Cloudflare. Fake-ip `198.18.0.0/15` alone is not evidence the origin is down. `did not complete: status ...` is a provider/session rejection, not the empty-secret race.

**Rule**

Native-secret authorization is command-inline. Recovery may resume install, uninstall, refresh, disconnect, and runtime reconcile from persisted state. It must not replay `start_authorization`, because the user secret is not durable. Crash leftovers must fail so a later Connect is not blocked by `operation in progress`. Live control-plane failures must keep their status or session outcome in the command error; do not collapse them to an empty `could not be started` toast with no cause.
