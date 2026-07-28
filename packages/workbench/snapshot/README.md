# @tutti-os/workbench-snapshot

Framework-neutral workbench snapshot contract helpers for Tutti workbench
surfaces.

The package exports stable TypeScript types, normalization helpers, validation
helpers, and the published JSON schema at:

```text
@tutti-os/workbench-snapshot/schema.json
```

Snapshots may include an additive `layoutBasis` containing the surface size and
layout constraints used to produce persisted frames. Workbench hosts use that
basis to restore window and space frames relative to a different surface.
Snapshots written before this field existed remain valid schema-version-1
snapshots and restore through the host's conservative legacy bounds policy.
