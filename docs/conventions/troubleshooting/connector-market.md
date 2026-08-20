# Connector Market Troubleshooting

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
Continue when Start returns a synthesized `external_link` view. Only Cancel
ends the round. After Cancel, the
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
