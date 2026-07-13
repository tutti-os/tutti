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
