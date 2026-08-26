# Workspace App Popup Boundary Design

## Context

Workspace App popups must enter Desktop through one canonical Electron policy
owner. A popup request must not be inferred or deduplicated later
from workspace, source-node, URL, or locally generated identifiers. Every real
popup request produces one Browser open-URL event, and two real requests remain
two launches because `reuseIfOpen: false` is intentional.

The current canonical-producer direction is correct, but three boundary risks
remain:

- a guest attachment callback can fail before the package installs its popup
  router, leaving an `allowpopups` guest without a deny handler;
- the published `onGuestAttached` hook changed behavior without a type-level
  migration and can silently lose a legacy handler;
- the real Electron regression stops at the Browser event and cannot distinguish
  duplicate renderer launches from duplicate Workbench materialization.

POST popup bodies are outside the URL-only Browser open-URL contract. They must
remain rejected rather than being replayed as GET requests, but the rejection
must be visible to the user.

## Goals

- Establish popup security ownership before host extension code runs.
- Preserve the published legacy guest-attachment behavior.
- Give Desktop a separate typed resolver for host-owned popup routing.
- Correlate one real popup action through producer, event, launch, and final
  Workbench surface cardinality without using an operation ID for correctness.
- Surface unsupported POST popup attempts through localized Desktop UI.
- Route internal popup targets in the current guest and external targets to a
  Browser Node without preload-owned policy.
- Make deferred popup and `WindowProxy` compatibility boundaries explicit.

## Non-goals

- Deduplicating independent popup requests.
- Adding an action ID or operation ID to `BrowserNodeOpenUrlEvent`.
- Transporting or persisting POST request bodies.
- Allowing native Electron child windows for Workspace Apps.

## Package Security and Compatibility

`installBrowserWebviewSecurity` installs the stable guest window-open router as
the first `did-attach-webview` action. The initial route denies native popup
creation. User-agent normalization and host callbacks run only after that
security ownership exists. If setup throws, the error is logged and the guest
keeps the deny route.

The public package restores `onGuestAttached` to its legacy callback contract:
the callback receives `WebContents`, returns no route, and may install its own
handler after the package default. A new, explicitly named attachment resolver
returns `BrowserWebviewGuestAttachment` for hosts that participate in the stable
router. Desktop migrates to the resolver. This avoids changing the meaning of a
published hook while keeping the single-delegate route for new hosts.

The route priority remains host attachment, registered Browser guest, then
fallback. Installing or updating a route never installs a second delegate.

## Desktop Composition

Workspace-window webview security composition moves behind one Desktop-owned
installer. Production window creation and the Electron fixture both call this
installer, so the fixture cannot manually recreate the popup handler wiring.
The installer owns the additional Workspace App partition prefix, guest
registration, preload selection, and attachment resolver.

The preload keeps explicit Tutti API bridges but does not globally intercept
blank-link clicks or patch `window.open`. Blank links, `window.open()`, and
popup forms all reach Electron. The handler compares an accepted HTTP(S) target
with the current guest origin. Internal targets return `deny` and schedule
navigation in the current guest after the callback; external targets return
`deny` and emit one Browser open-URL event.

## Unsupported Popup Feedback

The main-process handler denies any popup with `postBody` and emits a narrow
Desktop-private rejection payload containing only a reason code. It does not
send the URL or request body. The preload exposes a typed subscription, and the
workspace renderer maps the reason to Desktop i18n copy and an error
notification. This keeps user-visible policy in Desktop and avoids expanding the
public Browser Node event contract.

Empty and `about:blank` popup targets are also rejected with a distinct reason.
This explicitly does not support SDKs that open a placeholder and later assign
`popup.location`; supporting them requires a separately owned managed-popup
contract. Because every native child is denied, `window.open()` returns `null`,
and Workspace Apps must not call `focus`, `location`, or `close` on its result.

## Validation Chain

The regression suite keeps the real Electron/webview producer test and adds one
connected chain using production modules:

1. A real popup action reaches exactly one `setWindowOpenHandler` callback.
2. An internal target navigates the current guest with no Browser event, while
   an external target emits exactly one Browser open-URL event.
3. The real workspace Browser service and launch coordinator issue exactly one
   Workbench launch.
4. The Workbench host snapshot gains exactly one Browser surface.

The same chain runs a second case with two actual popup requests and expects
`2 callback -> 2 event -> 2 launch -> 2 surface`. Separate security regressions
cover callback failures and the legacy published handler override.

POST coverage asserts one producer callback, zero Browser events, zero launches,
zero Browser surfaces, zero native child windows, and one localized rejection
notification.

Deferred-popup coverage asserts the same fail-closed cardinality and verifies
that `window.open("")` returns `null`. Local Tutti Canvas, Deck, Doc, and built-in
Workspace App sources contain no `window.open`, `_blank`, or retained
`WindowProxy` usage; third-party application compatibility remains governed by
the explicit unsupported boundary.

## Documentation Impact

Update the Browser Node architecture and popup troubleshooting documentation to
record the fail-closed attachment order, the legacy/new hook split, the
Desktop-private POST rejection UX, and the connected cardinality test.
