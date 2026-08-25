# Browser Node Package

This document records the current package boundary for sharing the Browser Node
capability across desktop hosts.

The intent is to align both products on one reusable browser runtime while
keeping product-specific business capabilities in thin host adapters.

## Direction

The implementation uses one deep package:

```text
@tutti-os/browser-node
```

Repository path:

```text
packages/browser/workbench-node
```

This path introduces the `packages/browser/*` group. The `workbench-node`
directory name clarifies that this package owns the Workbench Browser Node
surface, not every possible browser integration.

## Design Decisions

The current package uses these decisions:

- Package name: `@tutti-os/browser-node`.
- Repository path: `packages/browser/workbench-node`.
- Runtime preview proxy: package-owned and optional. Hosts provide loopback
  preview target resolution and fallback policy; the package owns Electron
  session proxying, HTTP forwarding, WebSocket forwarding, and redirect
  rewriting.
- Bridge namespace: host-defined only. The package must not provide a default
  namespace because TSH and Tutti expose different guest globals.
- Address search provider: host-defined only. The package normalizes ordinary
  navigation URLs, but a host decides whether a non-URL address bar input turns
  into a search URL and which provider to use.
- Runtime errors: package events carry structured error codes and optional
  diagnostics. React surfaces map those codes through package i18n resources
  instead of rendering IPC strings as user-visible copy.

## Design Goal

The package should be large internally and small externally.

Business hosts should consume a Browser Node capability, not copy a set of TSH
or Tutti implementation files. The package owns browser behavior; each host
only provides product adapters.

The ordinary Browser surface and the Workbench Browser node render the same
`BrowserNodeChrome` and `BrowserNodeActionsMenu`. The chrome has a shared tab
strip above a navigation row, so the broad top-row blank area is the window
drag target while the address bar remains fully interactive below it. The
Workbench adapter does not recreate either row: it renders the same component
and declares the Browser-owned header presentation through the node definition:
`window.header: { heightPx: 76, overflow: "visible" }`. Workbench projects the
height to `--workbench-header-height` on the owning window.

The menu stays inline so its Electron guest-overlay coordination is identical
in both shells. Workbench projects the declared overflow policy to
`data-window-header-overflow="visible"` on `.workbench-window` and allows the
otherwise clipping custom-header row to extend over the node body. The outer
Workbench window still clips content to the window bounds.

Tabbed Browser surfaces keep a feature-owned tab store keyed by the Workbench
surface node ID. Each tab receives a stable child Browser Node ID and owns its
own controller, guest webview, navigation history, runtime title, and actions.
Inactive tab guests remain mounted but hidden so switching tabs does not reload
their pages. Closing a tab closes and clears only that child guest; closing the
surface closes all remaining child guests. Snapshot titles, URLs, Dock labels,
and previews resolve through the active child ID while the Workbench shell
continues to persist the parent surface ID. Hosts that scope Browser events to
one surface must use the package-owned surface-event predicate so both the
parent ID and its `:tab:*` child IDs are accepted without admitting events from
other Browser surfaces.

The final tab is a surface-close action, not a child-guest close. Standalone
hosts may handle it through the ordinary Browser `onCloseRequest`; the shared
Workbench adapter binds its dedicated final-tab request to
`windowActions.close()`. It must not send the parent surface ID to
`BrowserNodeHostApi.close()`, because that API closes registered child guests
and does not remove a Workbench node. Once the Workbench node unmounts, the
tab-surface leases close every remaining child guest.

Ordinary guest `target="_blank"` links and `window.open` calls emit an
`open-url` event with the exact source child ID. The full workspace Browser host
uses that identity to create and select a new tab in the same Browser surface.
It must not translate this explicit popup intent into a passive Workbench
`defaultUrl` update: controller synchronization deliberately ignores
same-origin URL differences so normal in-page and authentication redirects are
not reset by stale host state. Before the new child guest publishes runtime
state, the Workbench adapter resolves its initial URL from the active tab's
stored URL ahead of the static product home page. Explicit activation and
restored runtime state remain higher-priority sources. This keeps the package's
tab state authoritative during materialization without moving Browser mechanics
into a Desktop host adapter.

The workspace host keeps one active Browser feature route per workspace and
source. Rebuilding a Workbench contribution replaces and disconnects the prior
route before it can handle another event, and disposing the Workbench session
releases every Browser route for that workspace. A weak lookup does not replace
this lifecycle: a route that still strongly owns its lookup key would also keep
the obsolete feature and tab store alive.

Host-level URL launches reuse Browser pages, not the active page's navigation
slot. Tutti searches eligible Browser surfaces in recent-use order and selects
an existing tab when its live URL matches, then uses its requested URL as an
alias when the page redirected. If no page matches, it creates a tab in the most
recent initialized Browser surface. If that surface's tab state is not
available, it launches a new Browser surface instead of replacing the active
page. Explicit non-reuse requests continue to launch a new surface.

Workspace App popups have one main-process policy owner. Preload does not
intercept blank-link clicks or patch `window.open`; blank links, `window.open`,
and popup forms all reach the guest's single `setWindowOpenHandler` delegate.
Desktop keeps the Electron popup decision and same-origin guest navigation in
`main/windows/workspaceAppWindowOpen.ts`, while
`main/host/workspaceAppBrowserOpen.ts` owns publication of the accepted
external URL to the Browser event channel. `main/ipc/*` adapters delegate to
those owners instead of implementing popup policy or Browser host dispatch.
The host-provided Workspace App route has priority over the default Browser
route; later `registerGuest` calls only update the delegate's Browser route and
never reinstall or override the handler. Main compares an accepted HTTP(S)
target with the current guest origin. Internal targets return `deny` and then
navigate the current guest; external targets return `deny` and emit exactly one
Browser open-url event. Returning `deny` means page code receives no child
`WindowProxy`; apps must not depend on `focus`, `location`, or `close` on that
return value. Empty or `about:blank` deferred-navigation popups and POST popup
forms are rejected with localized feedback because the Browser open-url
contract cannot preserve their later navigation or request body. Rejection
events use the Workspace App-specific preload API and IPC namespace rather
than extending the generic Browser host API. Workspace App session partition
construction, parsing, and validation share the single contract in
`shared/contracts/workspaceAppSessionPartition.ts`; renderer and main must not
redeclare its prefix. Renderer behavior does not deduplicate or merge events by
source node or URL. Every accepted external popup remains an independent
`reuseIfOpen: false` launch, and the Workbench presenter remains the narrow
launch/focus adapter. Default reuse requests still delegate to the workspace
Browser page service so matching tabs are focused, missing URLs become tabs in
an initialized Browser surface, and unavailable tab state launches a new
surface.
The explicit Workspace App `browser.openUrl` bridge remains an IPC command and
is logged as `external-browser-api`; it is an application API request, not a
second DOM-popup transport.

## Package Entry Points

The package uses multiple exports from one package rather than several small
packages:

```text
@tutti-os/browser-node
@tutti-os/browser-node/react
@tutti-os/browser-node/workbench
@tutti-os/browser-node/chrome-cookie-import/macos
@tutti-os/browser-node/electron-main
@tutti-os/browser-node/electron-preload
@tutti-os/browser-node/bridge
@tutti-os/browser-node/i18n
```

Internal shape:

```text
packages/browser/workbench-node/
  src/core/
  src/react/
  src/workbench/
  src/chrome-cookie-import/macos/
  src/electron-main/
  src/electron-preload/
  src/bridge/
  src/i18n/
```

## Package Ownership

The Browser Node package owns:

- browser node state and lifecycle
- feature-scoped multi-tab state, active-tab resolution, and child guest
  cleanup
- navigation, back, forward, reload, close, and URL normalization
- page find, printing, zoom, visible-area and full-page screenshot capture,
  fixed device emulation, Cookie import, and browsing-data clearing against the
  registered guest
- the browser settings surface for current-session device, zoom, screenshot,
  download, Cookie, and data controls
- node-scoped host-overlay visibility coordination so Electron guest surfaces
  cannot cover package menus or dialogs
- download lifecycle state and generic pause, resume, cancel, open, and reveal
  actions
- address bar rendering and generic input resolution
- session, profile, and incognito partition logic
- React body and shared two-row tab/header surface
- the active guest webview context exposed to navigation actions, so host
  actions operate on the actual active Tab webview rather than reconstructing
  that identity from DOM markers
- workbench node definition helpers
- Electron webview registration and unregistration coordination
- Electron guest `webContents` state synchronization
- webview security policy
- guest preload bridge framework
- guest `window.open` and link interception
- generic runtime preview proxy mechanics
- the reusable macOS Chrome Stable and Dia Profile, SQLite snapshot, Keychain,
  and Cookie decryption adapter
- default package i18n resources for generic browser behavior
- an optional host-rendered Browser Home slot for empty tabs; the host owns
  service discovery and product-specific shortcuts while the package owns
  navigation back into the guest
- Electron BrowserNode automation target registration, CDP-backed snapshot,
  interaction, evaluation, navigation, and screenshot mechanics
- per-Agent stable page selection and per-tab automation leases
- per-target command serialization, navigation-time snapshot invalidation, and
  request interception for redirects and subresources while a lease is active
- an authenticated loopback automation endpoint that a daemon can select
  explicitly instead of launching a second browser backend

The host owns:

- product i18n runtime composition
- product logging adapter
- product diagnostics policy
- address search provider policy
- IPC channel registration and preload global wiring
- external URL opening policy
- native screenshot save dialogs and file writes
- native Cookie-file and download-directory selection, file reading, file
  opening, and file revealing
- loopback preview target resolution
- bridge namespace, such as `__tsh` or `__tutti`
- bridge methods, such as TSH agent/game/share actions or future Tutti actions
- product authorization and host allowlist policy
- daemon or server clients
- any business mutation triggered by a guest page
- which BrowserNode surfaces are visible to automation, how Agent Browser tabs
  are created/selected/closed, and when an Agent lease is released
- automation network authorization; listing may expose a restricted page's
  title and URL, but inspect/control calls must fail closed

## Browser automation projection

BrowserNode is the desktop browser authority. A host opts individual tabs into
automation by attaching metadata with the workspace, surface role (`user` or
`agent`), optional Agent session, selected state, and focus state. Website App
guests do not attach this metadata and therefore never enter the automation
registry.

The registry exposes User Browser tabs in the current workspace plus Agent
Browser tabs owned by the calling Agent session. The most recently focused
selected tab is the initial target; an explicit page selection remains stable
for later calls. A tab has one time-limited Agent automation lease, while user
input remains available through Electron throughout the lease. Releasing an
Agent is a barrier: already-queued target work completes before its request
guard is disabled, retained Agent pages are then closed, and later calls for
that Agent session are rejected.

Desktop hosts publish the registry over a versioned HTTP endpoint bound to
`127.0.0.1` with a random bearer token stored in a mode-`0600` listener-info
file. The managed daemon receives that file path explicitly. When configured,
it must fail if the BrowserNode host is unavailable and must not fall back to a
separate Chrome process. A daemon without the configuration remains the
explicit headless mode and may own managed Chrome.

The Desktop renderer owns page lifecycle. A renderer announces readiness only
for its main-verified workspace and surface role. Main records the exact
renderer that created each page, sends later select/close requests to that
owner, and accepts a response only from the renderer that received the request.
`new_page` always creates a new tab in the full workspace User Browser, even
when an Agent session is the automation owner. The workspace renderer restores
and focuses the preferred Browser node, or launches one when none exists, then
returns the exact child tab id. If no User Browser host is ready, Main opens the
workspace window explicitly, independent of the primary workspace UI mode, and
waits for its verified readiness before sending the create request. Main then
reveals and focuses that exact owning workspace window for the first page-create
request. Agent-issued requests also carry the daemon's persisted active Turn
identity as presentation context. Main marks only the first page-create request
in each workspace, Agent session, and Turn for reveal; both workspace and
standalone Agent renderers obey that presentation flag before switching to the
Browser surface. Later creations in that Turn still create and select their tabs
without repeatedly taking foreground focus. The reveal cache is bounded, and
requests without an exact Turn identity retain the previous reveal behavior.
The Agent session identity still owns the
automation lease and request guard; it does not choose a narrow Agent UI
surface. Metadata-only inspection, screenshots, select, and close operations do
not activate a window, and performance-headless runs remain non-activating.

Automation-created tabs carry a narrow cold-materialization intent so their
initial `about:blank` guest can attach before guarded navigation. Automation
target identity alone does not materialize an ordinary cold Browser tab; this
keeps restored and background Browser surfaces lazy.

Agent Browser tabs may still be registered for session-owned embedded surfaces
and remain visible only to their owning Agent. If no Agent renderer exists for
an explicit Agent-surface operation, Desktop may start one hidden without
taking focus and wait for readiness. Agent Browser tabs are keyed by their
resource Agent session; switching the active conversation does not rebind them.
Deleting an Agent session releases its leases and closes retained Agent Browser
surfaces, while User Browser tabs remain under user lifecycle ownership.

Network authorization runs before leasing or creating a tab. `new_page`
creates only `about:blank`, attaches CDP request interception, and then loads
the requested URL. The same policy therefore covers the initial document,
main-frame redirects, subresources, and script-initiated requests. The standard
policy permits public, private, local-network, metadata, and loopback HTTP/HTTPS
destinations alike, matching manual Browser navigation reachability. It still
rejects invalid URLs and non-HTTP protocols.

`BrowserNode` also accepts a `renderHome` slot. The package shows it only for
an empty/`about:blank` tab and supplies a package-owned navigation callback.
Hosts can use the slot for live sandbox service-port shortcuts without moving
runtime discovery or product UI into this package.

Browser data actions are scoped through the registered guest's Electron
session. Clearing data therefore affects the active Browser Node partition:
all nodes using the shared partition observe the clear, while profile and
incognito partitions remain isolated. Hosts must not redirect a clear request
to Electron's default session.

Download progress is package-owned runtime state because it is generic browser
mechanics. The host still owns operating-system paths and shell integration;
the package never chooses a product download directory or opens local files
without an explicit host callback.

Browser settings in the reusable React surface are session-scoped. Device
emulation and zoom are applied to the registered guest, while a chosen download
directory is applied to that guest's Electron session. These controls do not
make popup or external-navigation security policy configurable.

Cookie import accepts JSON arrays (or an object with a `cookies` array) and
Netscape Cookie files. The host selects and reads the file in the main process;
file contents and Cookie values never cross into the renderer or diagnostics.
The package validates each entry and writes it only to the registered guest's
Electron session Cookie store. Invalid or rejected entries are counted and
skipped without logging their values.

Hosts may additionally inject a renderer-safe Chrome and Dia Cookie capability. The
Browser package owns its opaque Profile/display contracts, selection and
prompt state model, normalized write aggregation, and same-`Electron.Session`
Browser refresh behavior. Its macOS adapter owns Chrome- and Dia-specific discovery,
absolute paths, database snapshots, OS credential access, decryption, and
schema/integrity compatibility checks. Hosts own only enablement, diagnostics,
notification, and registration policy. Preparation must complete before the
Browser package starts any Cookie write, so a source-level failure leaves the
target session untouched. Cancellation is accepted only during preparation;
after the first write begins, the operation completes and reports through the
main-process result/notification path. Cookie values and credential material
stay in the main process.

Profile discovery may expose only opaque ids and renderer-safe display data.
The macOS adapter converts a validated, size-limited Profile picture into an
image data URL; Chrome-internal avatar URIs and filesystem paths do not cross IPC. Import
refresh additionally requires `sessionPartition === null`, so custom Workspace
App Sessions are excluded even if a host accidentally shares an Electron
Session object with an ordinary Browser.

Tutti's macOS adapter supports Chrome Stable at its standard User Data root and
Dia at `~/Library/Application Support/Dia/User Data`; it imports only ordinary,
non-partitioned Cookies. It deliberately omits CHIPS, custom browser roots,
other Chromium browsers, incognito and Guest profiles, Workspace App sessions,
and all non-Cookie browser data. The Desktop
renderer supplies the global versioned prompt-dismissal adapter; the reusable
package does not embed a Tutti preference key.

## Host Interface Shape

The package should be configured through a host capability object. The exact
types can evolve during implementation, but the public shape should feel like:

```ts
import { createBrowserNodeFeature } from "@tutti-os/browser-node";

const browserNodeFeature = createBrowserNodeFeature({
  hostApi: desktopApi.browser,
  i18n,
  resolveSearchUrl(query) {
    const searchUrl = new URL("https://www.google.com/search");
    searchUrl.searchParams.set("q", query);
    return searchUrl.toString();
  }
});
```

Workbench registration should stay thin:

```ts
import { createBrowserNodeDefinition } from "@tutti-os/browser-node/workbench";

const browserNode = createBrowserNodeDefinition({
  defaultUrl: "https://www.google.com/",
  feature: browserNodeFeature,
  typeId: "browser"
});
```

Electron main registration should also be thin:

```ts
import { registerBrowserNodeElectronMain } from "@tutti-os/browser-node/electron-main";

registerBrowserNodeElectronMain({
  channels,
  getOwnerWindow,
  logger,
  openExternal,
  resolveWebContents,
  registerHandler
});
```

macOS hosts enable Chrome import through the package-owned source adapter:

```ts
import { createMacosChromeCookieImportAdapter } from "@tutti-os/browser-node/chrome-cookie-import/macos";

const chromeCookieImport = createMacosChromeCookieImportAdapter({
  isEnabled: () => preferences.isEnabled("browser.chromeCookieImport"),
  logger
});

registerBrowserNodeElectronMain({
  ...chromeCookieImport,
  channels,
  getOwnerWindow,
  openExternal,
  registerHandler,
  resolveWebContents
});
```

Hosts that need guest-page bridge injection should keep the package-owned
security baseline and provide the host-owned preload path through the webview
security installer:

```ts
import { installBrowserWebviewSecurity } from "@tutti-os/browser-node/electron-main";

installBrowserWebviewSecurity({
  contents: ownerWindow.webContents,
  openExternal,
  resolveGuestAttachment(guestContents, { params }) {
    return registerHostGuestRoute(guestContents, params.partition);
  },
  resolvePreload: () => browserGuestPreloadPath
});
```

The installer clears any guest-supplied preload first and applies the host
resolver only after Browser Node partition and URL validation succeeds. On
attachment it first installs a stable deny handler, then applies the guest user
agent and calls `resolveGuestAttachment`. A returned `windowOpenHandler` updates
that stable delegate without reinstalling it; if setup throws, the guest stays
fail closed. The legacy `onGuestAttached(guestContents)` hook remains available
for published consumers that directly replace Electron's handler. It runs last
to preserve that override behavior, and an exception restores the package deny
handler.

Guest preload installation should not hardcode a product namespace:

```ts
import { installBrowserNodeGuestBridge } from "@tutti-os/browser-node/electron-preload";

installBrowserNodeGuestBridge({
  call,
  methods,
  namespace: "__tutti"
});
```

## Host Integration

Hosts consume Browser Node through workbench, Electron main/preload, bridge,
and i18n entrypoints. Each host supplies adapters for its bridge namespace,
search policy, preview routing, external-open behavior, logging, and product
capabilities. Product-specific bridge methods, service discovery, room or
workspace lookup, and user-visible copy remain in the host.

## Security Invariants

The Browser Node package must preserve these invariants:

- guest pages never receive daemon or control-plane bearer tokens by default
- guest pages receive only explicitly registered bridge methods
- bridge methods are filtered by host allowlist before invocation
- webview preload path is package or host controlled, never guest controlled
- `nodeIntegration` stays disabled for guest pages
- `contextIsolation` stays enabled for guest pages
- `sandbox` stays enabled for guest pages
- `allowpopups` is denied by default
- navigation is limited to HTTP and HTTPS unless a host explicitly extends it
- local preview proxying is optional and routed through host-provided policy
- Cookie files are read in the host main process and imported only into the
  active registered guest session

## Why One Deep Package

Browser Node behavior crosses renderer, preload, and main. Splitting it into
many small packages would make the public interface nearly as complex as the
implementation. One package with multiple entry points keeps locality for
browser lifecycle fixes while keeping host integration explicit.

The package is deep when callers can register a browser workbench node, main
handlers, and guest bridge with a small amount of product adapter code.
