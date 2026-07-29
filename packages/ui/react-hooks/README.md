# @tutti-os/ui-react-hooks

Host-agnostic React hook helpers for shared Tutti frontend packages.

This package is published to npm as `@tutti-os/ui-react-hooks`.

Use it for narrow reusable React hook patterns such as external-store snapshot
subscription, selector reads, and IME-safe controlled input state. Keep domain
hooks and UI components in their owning packages.

Prefer this package over adding new direct `useSyncExternalStore` wrappers in
shared frontend packages so subscription semantics stay consistent.
`useExternalStoreSnapshot` keeps its React subscription callbacks stable while
the source identity is unchanged, so source consumers do not unsubscribe and
resubscribe on each render.

This package does not replace adapter-level snapshot memoization. If a non-React
adapter exposes a derived `getSnapshot()`, keep reference-stable snapshot reuse
in the owning package.
