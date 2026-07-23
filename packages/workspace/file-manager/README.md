# @tutti-os/workspace-file-manager

Reusable workspace file manager service, session state, host contracts, and
optional React UI.

**Authority for ownership and boundary decisions:**
[CONTRACT.md](./CONTRACT.md). Read that file before changing the host
contract, session ownership, context-menu DI, persistence schema, or
activation/preview boundaries.

Hosts compose the package through `createWorkspaceFileManagerService()` and
`createSession(...)`. A session owns the shared file-manager data state, shared
interaction state, preview flow, and activation flow for one
workspace-scoped instance.

Hosts provide backend capabilities through `WorkspaceFileManagerHost`. The
package keeps shared state in logical workspace paths such as
`/workspace/src/index.ts` and does not depend on tuttid, TSH, TACH, VM paths,
or host absolute paths.

This package is intentionally a reusable frontend workspace-domain surface, not
only a transport-agnostic data kernel. Shared session orchestration, preview
flow, activation flow, and React-facing interaction state may live here when
they are part of the reusable file-manager experience across hosts.

The shared surface consumes host-neutral classification and loading lifecycle
from `@tutti-os/workspace-file-preview`. This package owns file-manager-specific
activation-target shaping, localized state projection, shared view-model
derivation, and the host contract needed to drive those flows so different
hosts can integrate primarily by implementing `WorkspaceFileManagerHost`
instead of rebuilding workflow around the shared UI.

The optional React surface persists the adjustable locations-sidebar and
details-panel widths on the current device. Restored widths are clamped to the
available surface so the central file list keeps its minimum usable width. The
locations sidebar can use the space normally reserved for file details when a
host hides the details panel, which keeps long location names readable in
compact tool-sidebar layouts. In narrow list layouts, the name column keeps a
usable minimum width. Starting a locations-sidebar resize preserves the name
column's current width so modified-time and size metadata shrink from the first
drag movement.

Hosts now provide one app-level i18n runtime and scope it into the file-manager
namespace, rather than hand-assembling package-local message objects.

The React surface renders its default archive and folder fallbacks with
code-owned `@tutti-os/ui-system` SVG icon components. Keep the package root free
of fallback image imports: browser-conditioned test environments may select a
raw image export and then externalize the package for Node execution, which
cannot evaluate `.png` modules. The legacy
`@tutti-os/workspace-file-manager/assets/workspace-*-fallback.png` subpaths
remain available to browser consumers that explicitly need the artwork, but
the shared runtime does not depend on them.

What stays outside this package is concrete host integration: desktop preload
calls, tuttid transport wiring, host absolute paths, import/export/upload
flows, share/exposure flows, and other product-specific integration details
belong in the owning host adapter. See [CONTRACT.md](./CONTRACT.md) for the full
ownership table and non-goals.

## Host Reuse Pattern

When another host wants to reuse this package:

1. Implement `WorkspaceFileManagerHost` in the consuming host.
2. Keep host transport, local-file picking, and environment-specific
   capabilities in that host adapter.
3. Create one host-level i18n runtime that merges:
   - host-owned product i18n resources
   - `workspaceFileManagerI18nResources`
   - any other shared package i18n resources needed by the same surface
4. Scope that runtime into the file-manager namespace with
   `createWorkspaceFileManagerI18nRuntime(...)`.
5. Provide `resolveContextMenu` when using the React surface so blank,
   directory, and file menus stay host-owned.
6. Override wording in the host runtime when the host intentionally owns the
   product phrasing; otherwise fall back to the package defaults.

This keeps the package reusable across different hosts without pushing host
transport wiring or product wording into the shared package.
