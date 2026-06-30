# Workbench

This document defines durable Workbench ownership rules across shared packages,
the desktop renderer host, and `tuttid` snapshot persistence.

## Purpose

Workbench is a reusable shell for workspace tools. It owns window-like
interaction mechanics, layout, dock identity, node shell lifecycle, and snapshot
sanitation.

It must not become a product workflow core.

## Ownership

Current ownership:

- `packages/workbench/snapshot` owns the canonical TypeScript snapshot contract,
  migrations, normalization, validation, and JSON Schema.
- `packages/workbench/service` owns shared Go snapshot validation,
  canonicalization, and the storage-facing service contract.
- `packages/workbench/surface` owns reusable Workbench mechanics:
  controller commands, host/session reconciliation, placement, stacking,
  dock rendering, window chrome, render context plumbing, and shell snapshot
  sanitation.
- `apps/desktop/src/renderer/src/features/workspace-workbench` owns the Tutti
  desktop host adapter: product contributions, tuttid clients, preload
  adapters, workspace context, close policy, launch policy, and desktop-owned
  Workbench copy.
- `services/tuttid/service/workspace` owns daemon-side Workbench snapshot load,
  save, and host-specific snapshot reconciliation before a snapshot is returned
  to desktop.

## Shared Package Rules

`packages/workbench/*` should stay product-neutral.

Rules:

- keep product-specific node bodies, daemon clients, preload calls, filesystem
  access, and workflow policy out of shared Workbench packages
- keep product-specific CSS selectors and host globals out of
  `@tutti-os/workbench-surface`
- keep window chrome hit zones unambiguous; floating-window resize handles
  should render outside the clipped window surface so corner handles remain
  reachable and take precedence over header drag regions; interactive controls
  inside or near draggable chrome must opt out with the product no-drag classes
  and `-webkit-app-region: no-drag`, but noninteractive wrappers should not
  shrink the draggable hot zone
- inject debug diagnostics, product callbacks, and host-specific behavior
  through explicit props or adapters
- keep `WorkbenchHostHandle` narrow; product consumers should call public host
  commands instead of reaching into the raw controller
- expose raw controller access only through an internal runtime handle used by
  Workbench surface internals
- keep package root exports intentionally small; exporting a symbol makes it a
  stable interface, not just a convenient file shortcut

Shared packages may own narrow default copy for generic Workbench mechanics,
such as chrome and dock labels. Product-owned copy stays in the consuming host
i18n layer.

## Snapshot State Rules

Workbench snapshots persist shell-owned presentation state plus explicit
host-owned node state.

Rules:

- `snapshotNodeState` is the only persisted node extension field for host-owned
  node state
- `externalNodeState` is runtime render input, not a persisted compatibility
  field
- node state sources should expose snapshot state through
  `getSnapshotNodeState(...)`
- snapshot sanitizers and session serialization must strip transient runtime
  render data before persistence
- adapter-specific durable state should remain behind generic contract fields
  unless the adapter detail is part of the shared snapshot contract

Breaking migration rule:

- when the snapshot contract intentionally removes a compatibility field, do not
  keep silent fallback code in the renderer or daemon; make the break explicit
  and update tests around the new durable contract

## Desktop Host Rules

The desktop workspace Workbench is a host adapter, not a React page that owns
Workbench workflows.

Rules:

- keep product contribution factories and host adapter assembly in
  `workspace-workbench/services/internal/**`
- expose public service/controller seams from
  `workspace-workbench/services/*` when UI needs model data or commands
- keep `workspace-workbench/ui/**` shallow: render snapshots, subscribe through
  hooks, and forward DOM events to services or controllers
- do not import `workspace-workbench/services/internal/**` from
  `workspace-workbench/ui/**`
- keep daemon reads, writes, save requests, object URL lifecycle, and similar
  side effects in feature services or controllers, not node body React files
- keep launchpad option projection, provider catalog shaping, and stable
  Workbench node id helpers behind public desktop service seams

The mechanical guard for the Workbench UI-to-internal rule is:

```sh
pnpm check:renderer-boundaries
```

## Daemon Reconciliation Rules

`services/tuttid/service/workspace` may reconcile Workbench snapshots with
daemon-owned runtime state before returning them to desktop.

Rules:

- keep the core `WorkbenchService` focused on load, save, validation,
  canonicalization, and calling the configured reconciler
- put node-kind-specific cleanup behind a `WorkbenchSnapshotReconciler`
  implementation
- wire host-specific reconcilers explicitly in `services/tuttid/wiring.go`
- do not hide a fallback to a concrete node-kind service inside
  `WorkbenchService`

This keeps the service interface small while preserving locality for daemon
runtime cleanup such as terminal session reconciliation.

## Review Questions

When reviewing Workbench changes, ask:

1. Is this generic Workbench mechanics, or product workflow policy?
2. Is durable state going through `snapshotNodeState`, or is runtime
   `externalNodeState` leaking into persistence?
3. Does UI depend on a public service/controller seam instead of
   `services/internal/**`?
4. Does a product consumer need a narrow host command, or is it trying to grab
   the raw controller?
5. Is daemon reconciliation behind an explicit reconciler, or is node-specific
   logic being added to the core Workbench service?
