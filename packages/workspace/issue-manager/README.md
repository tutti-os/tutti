# Workspace Issue Manager

Reusable workbench issue-manager feature for workspace-scoped issue, task, and
run workflows.

This package owns host-agnostic contracts, i18n defaults, React-facing feature
types, and workbench registration helpers. Hosts provide backend, identity,
file, agent runner, ContextRef opener, and optional share adapters.

The ContextRef opener is the package boundary for opaque Issue or Task
attachments. `workspace_path` references delegate to the host's normal
workspace file adapter when that opener is absent. `managed_attachment`
references are opaque: the host retrieves
their bytes by workspace, Issue, and ContextRef IDs, stores them in a trusted
host-local location, and opens that copy. Reusable UI and domain contracts must
not depend on a daemon absolute path, which may be meaningless to a VM or
remote consumer.
The two shapes are discriminated: workspace references require `path`, while
managed attachments cannot expose it. For source compatibility, a legacy
reference that has `path` but no `accessKind` is treated as `workspace_path` and
falls back to the existing file adapter when no ContextRef opener is installed.

Hosts that want the package-owned default dock or empty-state visual can import
it explicitly from
`@tutti-os/workspace-issue-manager/assets/workspace-dock-task.png`.

See [docs/architecture/workspace-issue-manager.md](../../../docs/architecture/workspace-issue-manager.md)
for the current shared architecture and host-adapter model.
