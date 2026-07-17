# Network Proxy

Tutti exposes one desktop proxy preference for outbound product traffic. The
daemon owns and persists the preference in `desktop_preferences`; the renderer
only edits the value and presents its current state.

## Modes

- `system` is the default. Electron follows the operating-system proxy and PAC
  configuration. If Chromium would otherwise connect directly, an explicit
  `HTTP_PROXY` or `HTTPS_PROXY` from the user's login shell remains a fallback.
  Daemon clients and spawned processes use explicit proxy environment variables
  first and the macOS system proxy second.
- `manual` uses `http://127.0.0.1:<port>`, where the saved port is between 1 and 65535. This user preference overrides shell and system proxy values.

Loopback addresses, `localhost`, and `.local` names bypass the proxy. The manual
mode does not accept a remote host or credentials; users who need those should
configure the operating-system proxy or supported proxy environment variables.

## Runtime Propagation

Saving the preference applies it without restarting Tutti:

- daemon HTTP transports resolve the current preference for every request
- subsequently spawned agents, managed runtimes, Git commands, workspace apps,
  and terminals receive matching `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
  environment values
- Electron applies the preference to the default session and every new
  partitioned session, including Browser and workspace-app sessions

An already-running child process keeps the environment it received when it was
launched. Start a new agent or terminal after changing the proxy.

All non-local desktop main-process HTTP calls must continue to use the shared
Chromium-backed outbound fetch helper. All daemon HTTP clients must continue to
use the shared proxy-aware transport; direct `http.DefaultClient` usage is not
allowed in production paths.
