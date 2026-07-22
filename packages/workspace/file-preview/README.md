# @tutti-os/workspace-file-preview

Shared, host-neutral workspace file preview helpers.

**Authority for ownership and boundary decisions:**
[CONTRACT.md](./CONTRACT.md). Read that file before changing classification,
loading lifecycle, renderer hooks, or fallback behavior.

## Package surface

This package ships:

- Flat `previewKind` classification (`directory` / media / text-family /
  Office / `unsupported`), plus a separate coarser `visualKind` for icons
- `createWorkspaceFilePreviewController` for shared frontend loading lifecycle
  (readiness, cancellation, stale-request fencing, decoding, object-URL cleanup)
- Built-in React preview shells for `image` / `video` / `text`
- Host renderer registry (by `previewKind`) and a resolve chain:
  host hook → text degradation → unsupported state
- `toSurfaceState(controllerState, copy)` to project controller state into the
  React surface

Hosts inject read/projection capabilities. Product controllers keep selection,
editing, persistence, transport wiring, and localized error presentation.

Open / reveal / open-with / browser activation are **not** owned here. Those
helpers live on the host edge (for Tutti:
`@tutti-os/workspace-file-manager/services`).

Sources may provide `canReadEntry` as a capability gate. Returning `false`
blocks reads for every non-directory entry, while returning `true` also allows
the injected reader to classify file types that local extension detection does
not recognize. Omitting the callback keeps the default local classification.

HTML files degrade to source text in the built-in surface. Opening or executing
an HTML document belongs to a separate browser activation flow.
