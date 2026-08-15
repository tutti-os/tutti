# Connector Authorization View V2

## Decision

All Connector authorization UI is represented as a versioned
`AuthorizationViewEnvelopeV2`. An embedded provider page is the
`embedded_page` view variant; it is not a parallel `authorizationUrl +
presentation` rendering path.

The credential broker protocol remains transport-oriented. A V1 broker may
continue to emit `authorization_url`; after applying the Connector manifest's
URL allowlist, the host converts that event into a V2 runtime view.

## State and data flow

```text
credential broker authorization_url
  -> implementation host URL validation
  -> Connector host AuthorizationViewEnvelopeV2
  -> connector-market API authorizationView
  -> untrusted-schema parser
  -> shared AuthorizationView renderer
  -> host-provided embedded_page surface
```

Declarative native-secret forms enter the same renderer by adapting their V1
localized initial view into a V2 envelope. Form submission still targets the
existing native-secret backend and does not change its authorization API.

## Runtime view mapping

| Connector declaration           | V2 view         | Host behavior                                                         |
| ------------------------------- | --------------- | --------------------------------------------------------------------- |
| No embedded-page hint           | `external_link` | Open the validated HTTPS URL in the system browser                    |
| `presentation: "embedded_page"` | `embedded_page` | Render the validated HTTPS URL in the dedicated authorization surface |

`presentation` is therefore a host normalization hint, not UI state returned
to the renderer.

## Identity and browser continuity

- `viewId` identifies one exact view step. It is derived from the private
  authorization session identity and current URL, so a provider's next URL
  invalidates events from the previous step.
- `flowId` identifies the whole embedded browser flow. It stays stable when the
  provider emits another URL, preserving cookies and other in-memory browser
  session state without weakening stale-event rejection.
- Neither identifier exposes the provider credential or authorization URL.

## Desktop security boundary

The desktop host owns a dedicated authorization WebView policy:

- a private, in-memory partition scoped by `flowId`;
- HTTPS URLs only, with URL credentials rejected;
- sandbox and context isolation enabled;
- Node integration, plugins, insecure content, and preload scripts disabled;
- same-origin navigation stays in the surface;
- cross-origin navigation and popups are denied in the WebView and, when safe,
  opened in the system browser.

The current `embedded_page` capability therefore supports same-origin provider
flows. A Connector whose authorization requires cross-origin in-surface
navigation must use `external_link` until the schema carries an explicit Host-
validated navigation-origin policy.

The surface is not registered as a Browser Node guest and does not receive the
Browser Node preload or runtime privileges.

## Compatibility

- Existing credential brokers remain on `tutti.connector.credentials.v1`.
- The API keeps `authorizationUrl` during the compatibility window.
- A client that does not receive `authorizationView` adapts the legacy HTTPS
  URL into an `external_link` V2 view.
- When both fields exist, `authorizationView` is authoritative and is parsed
  strictly. An invalid view fails closed instead of falling back to the URL.
- Hosts that do not implement `embedded_page` retain the existing external
  browser behavior.

## UI implementation

The shared renderer continues using Tutti UI System components and semantic
tokens for headings, actions, form controls, dialogs, and state views.
The Electron `<webview>` itself is a host capability slot because the UI System
does not own native web contents; its surrounding layout uses the existing
semantic border and surface tokens.
