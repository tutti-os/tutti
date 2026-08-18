# Connector Market Troubleshooting

### Authorization stays loading and reopening cannot start a new attempt

**Symptoms**

- the authorization button may remain on its initial loading state before a URL
  is returned
- the local Start operation is already `completed` while its private session
  receipt is still unresolved
- the account authorization projection remains `disconnected` until the OAuth
  callback is observed
- closing and reopening the dialog appears to reuse the old request or reports
  that another Connector operation is in progress

**Check**

Trace four states separately: the renderer request identity, the durable Start
operation, its private authorization-session receipt, and the provider process.
A
completed Start operation means the external session was created; it does not
mean the provider authorization is terminal. Confirm that a redirect session
returns `pending` to the caller even when the durable projection has not changed
yet. Within one action, confirm that continuation uses one `clientRequestId`.
For a new user action, confirm that the request carries
`replacementPolicy=replace_active`, the prior receipt moves through `canceling`
to `superseded`, and the old Broker/DWS process exits before the replacement is
launched. If no initial event is returned, verify that the new request cancels
the active Host-owned Begin instead of waiting behind its authorization lane.

**Rule**

Keep the account projection as durable authorization truth. Preserve the
current session's `pending` state only in the Start command result so shared
clients continue that idempotent session. A new user action is different from a
continuation: it must use Host-owned replace-active semantics. Fence late
observations by the durable receipt, require provider cancellation and process
exit confirmation, then create the replacement. Do not persist a synthetic
connected projection, infer success from the Start operation's terminal state,
or let the renderer race separate cancel and start calls.

### OAuth finishes in the browser but does not return to the initiating desktop build

**Symptoms**

- the authorization result page renders and its return link uses a valid desktop scheme
- a development build started the flow, but the link targets the production scheme
- the result page host is `tutti.sh`, so deriving the desktop environment from the web host selects the wrong application

**Check**

Inspect the server-owned authorization bridge URL before it leaves the renderer. It must carry both the client identity and an exact `openAppUrl` for the initiating build, such as `tutti-dev://open`. Confirm the web transition page stores that value before navigating to the provider and that the result page uses the same sanitized value for both automatic navigation and the manual link.

**Rule**

The initiating desktop build owns the callback environment. Do not infer a production or development desktop scheme from the authorization website hostname. Web code must accept only the exact supported `open` routes and keep the legacy client marker solely as compatibility for already released clients.
