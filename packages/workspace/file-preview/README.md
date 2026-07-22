# @tutti-os/workspace-file-preview

Shared, host-neutral file preview helpers for workspace features.

This package owns file preview classification, safe byte handling, text
decoding, image mime resolution, and byte-limit helpers. Host adapters remain
responsible for reading bytes from the local workspace.

It also exposes a small React preview surface for consumers that want the shared
image, text, loading, and readonly rendering shell while keeping host-specific
icons and localized copy outside this package.

`createWorkspaceFilePreviewController` owns the shared frontend loading
lifecycle. Consumers inject a byte reader and entry projection; the controller
owns readiness checks, stale-request fencing, cancellation, decoding, canonical
language-neutral state, and media object-URL cleanup. Product controllers keep
selection, editing, persistence, transport, and localized error presentation.

Sources may provide `canReadEntry` as a capability gate. Returning `false`
blocks reads for every non-directory entry, while returning `true` also allows
the injected reader to classify file types that local extension detection does
not recognize. Omitting the callback keeps the default local classification.

HTML files are shown as source text. Opening or executing an HTML document
belongs to a separate browser activation flow rather than the ordinary file
preview surface.
