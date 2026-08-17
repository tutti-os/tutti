# @tutti-os/workspace-user-project

Reusable user-project contracts, path-label helpers, and optional React UI for
workspace surfaces that need to select an execution directory or recently used
project.

Hosts provide concrete project persistence, directory dialogs, and project
creation through package contracts. Daemon transport, desktop preload calls, and
host absolute-path ownership stay in the consuming host adapter.

UI copy is provided by the package i18n resources. Hosts can merge
`workspaceUserProjectI18nResources` into their app runtime and pass
`createWorkspaceUserProjectI18nRuntime(runtime)` to shared UI; `labels` are only
for explicit, narrow business overrides.

`WorkspaceUserProjectSelect` also accepts optional `menuActions`,
`showKnownProjectOptions`, and label overrides. Hosts may expose an optional
`importDirectory` operation for a Host-owned import flow. Omitting these inputs
preserves the package's existing action order, known-project rows, copy, and
directory-selection behavior.
