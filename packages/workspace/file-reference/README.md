# @tutti-os/workspace-file-reference

Reusable workspace file reference contracts, picker state, and optional React UI.

This package owns host-neutral file reference selection behavior for workspace
surfaces that need to browse, search, upload, preview, open, or share file
references. Hosts provide concrete file-system access through package contracts;
desktop preload calls, tuttid transport wiring, host absolute paths, and
product-specific integration stay in the consuming host adapter.

The package uses logical workspace paths and keeps reference picking reusable
across shared workspace features such as the agent GUI and issue manager.

Published React entry points use APIs available across the repository's
supported React 19 hosts. Avoid runtime imports that only exist in a newer
React minor: frameworks such as Next.js may alias React to their bundled
runtime even when dependency resolution installs a newer version.

It also provides host-neutral provenance filter contracts, an external-store
controller, and a controlled filter view. Hosts inject available Agent/member
options; source implementations declare which dimensions they can enforce and
apply active constraints before pagination. The package does not fetch a
catalog or infer product-specific membership itself. Disabled catalog options
remain available to host logic but are hidden by the controlled filter view by
default; a host can opt into rendering them with `showDisabledOptions`.

Browse pagination and search pagination are separate contracts. Existing
sources keep using the legacy growing-limit search protocol even when
`capabilities.paginated` enables browse cursors. A cursor-paginated search
source must explicitly declare `capabilities.searchPagination: "cursor"`.
`SearchResult.searchPagination` may override that default for one query, for
example when a source routes provenance search through a legacy backend.

For cursor search, the picker passes the returned `nextCursor` into the next
fixed-size request and incrementally deduplicates only the incoming page before
appending it to an immutable, bounded-block result index in source order. The
index copies at most one small tail block per page, so deep pagination neither
rescans all historical entries nor mutates a snapshot already observed by a
consumer. The picker renders a virtual search window over that index; the DOM,
icon subscriptions, focus updates, and selection updates therefore stay
bounded even when every backend result remains reachable by scrolling. Once
the browser scroll range is compressed, reaching the virtual window's logical
end drives cursor continuation directly, so appending a page does not depend
on the browser emitting another native scroll event.
Repeated or cyclic cursors stop
continuation with `ReferenceSearchCursorLoopError` instead of requesting the
same page forever. A host that receives an expired backend cursor
may throw `ReferenceSearchCursorExpiredError`; the picker clears the stale
result set and restarts the same search from its first page.

## Optional host actions and selection commands

`ReferenceSourcePicker` accepts an optional `renderSidebarActions` slot for
fixed Host-owned actions above the source tree. The slot is absent by default,
so existing markup and interaction remain unchanged. Picker action contexts
expose `selectTargets` for locating and selecting several authoritative source
targets after a Host mutation; each located node still passes through the
picker's active node-kind and single/multiple selection policy.

## Content error recovery

`ReferenceSourcePicker` accepts `resolveContentErrorAction` when a host can
offer recovery for selected content errors. Return an action label for errors
that should be retryable, or `null` to keep the default message-only state.
Selecting the action reruns the failed browse, search, or filtered-tree request.
Search recovery starts again from page one and never reuses a continuation from
the failed request.

```tsx
<ReferenceSourcePicker
  resolveContentErrorAction={(error) =>
    isRecoverable(error) ? { label: copy.t("actions.retry") } : null
  }
  {...props}
/>
```
