# @tutti-os/browser-node

Reusable Workbench Browser Node capability for Electron desktop hosts.

The package owns browser-node mechanics such as URL normalization, session
partitioning, renderer state, React surfaces, webview security, and Electron
guest lifecycle coordination. Product hosts own business bridge methods,
diagnostics policy, loopback preview routing policy, and daemon or server
clients.

The Browser Node overflow actions support page find, printing, zoom, fixed
device emulation, visible-area and full-page screenshots, download progress and
actions, Cookie import, and clearing the active session partition's browsing
data. Its browser settings dialog groups current-session device, zoom,
screenshot mode, download location, Cookie, and browsing-data controls.
Screenshot save dialogs, Cookie-file and download-folder selection, and
operating-system file open/reveal behavior are supplied by the host. Cookie
file contents stay in the main process and are written only to the registered
guest session.

## Chrome login-state import

The optional Chrome import capability is host-injected. The Browser package
owns renderer-safe profile contracts, Profile selection and prompt UI,
normalized non-partitioned Cookie writes, aggregate results, and refreshing
every registered ordinary Browser Node that shares the target Electron
`Session`. The package does not know Chrome paths, Keychain services, or a
product preference key.

The Tutti Desktop adapter currently supports only macOS Google Chrome Stable at
the standard `~/Library/Application Support/Google/Chrome` location. It
discovers `Default` and `Profile N` entries from `Local State`, prepares a
consistent SQLite snapshot, obtains Chrome Safe Storage from Keychain only
after an explicit import, decrypts `v10` values, and validates the version 24+
host hash before returning normalized Cookies to the Browser package. Paths,
database contents, secrets, keys, decrypted values, and Cookie identifiers
never cross into renderer code. A validated local Profile picture may cross as
a size-limited PNG/JPEG data URL; local paths and Chrome-internal avatar URIs
never do.

Import merges into the active ordinary persistent Browser session. It keeps
session Cookies as session Cookies and skips expired, damaged, rejected, or
partitioned (CHIPS) entries. Incognito nodes, custom Workspace App sessions,
other Chromium browsers, custom user-data directories, and non-Cookie Chrome
data are not supported. JSON and Netscape Cookie-file import remains available
as a fallback. A user cancellation aborts preparation before any write; once
the best-effort write phase starts, it runs to completion even if its window
closes. Foreground imports report aggregate success, partial, zero-write, or
failure feedback through the shared toast surface; a main-process notification
remains the fallback after the originating window closes.

For manual verification on macOS:

1. Open a normal persistent Browser Node and choose a discovered Chrome
   Profile from the prompt or Browser settings.
2. Allow the Chrome Safe Storage Keychain request and verify signed-in sites
   reload in every open Browser Node sharing that Electron session.
3. Verify independent Profiles, incognito nodes, and Workspace App browsers do
   not reload or inherit the imported Cookies.
4. With Chrome writing Cookies, repeat the import; if snapshot validation
   fails, quit Chrome and retry as prompted.

The package supports ordinary HTTP and HTTPS browser navigation by default. For
hosts that need local runtime previews, the Electron main integration can also
configure a package-owned loopback preview proxy through
`loopbackPreviewRouting`.

For Workbench hosts, the package also exposes a dock helper through
`@tutti-os/browser-node/workbench`. `createBrowserDockEntry(...)` wires the
dock label, matches Browser nodes back to the dock entry, and restores popup
title, URL subtitle, and preview capture from the Browser runtime state.
Hosts that want the package-owned default dock visual can import it explicitly
from `@tutti-os/browser-node/assets/workspace-dock-website.png`.
