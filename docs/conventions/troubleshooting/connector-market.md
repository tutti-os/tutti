# Connector Market Troubleshooting

### OAuth opens once, then the desktop stays disconnected or a second attempt supersedes the first

**Symptoms**

- the browser receives a valid OAuth redirect on the first authorization click
- the local Start operation is already `completed` while its private session
  receipt is still unresolved
- the account authorization projection remains `disconnected` until the OAuth
  callback is observed
- the renderer stops waiting, and a later click creates a new session that may
  supersede the first one

**Check**

Trace the three states separately: the durable Start operation, its private
authorization-session receipt, and the account authorization projection. A
completed Start operation means the external session was created; it does not
mean the provider authorization is terminal. Confirm that a redirect session
returns `pending` to the caller even when the durable projection has not changed
yet, then confirm the same client request identity is reused until the projection
becomes connected or failed.

**Rule**

Keep the account projection as durable authorization truth. Preserve the
current session's `pending` state only in the Start command result so shared
clients continue that idempotent session. Do not persist a synthetic connected
projection, infer success from the Start operation's terminal state, or create a
second external session to refresh the UI.

### OAuth finishes in the browser but does not return to the initiating desktop build

**Symptoms**

- the authorization result page renders and its return link uses a valid desktop scheme
- a development build started the flow, but the link targets the production scheme
- the result page host is `tutti.sh`, so deriving the desktop environment from the web host selects the wrong application

**Check**

Inspect the server-owned authorization bridge URL before it leaves the renderer. It must carry both the client identity and an exact `openAppUrl` for the initiating build, such as `tutti-dev://open`. Confirm the web transition page stores that value before navigating to the provider and that the result page uses the same sanitized value for both automatic navigation and the manual link.

**Rule**

The initiating desktop build owns the callback environment. Do not infer a production or development desktop scheme from the authorization website hostname. Web code must accept only the exact supported `open` routes and keep the legacy client marker solely as compatibility for already released clients.
