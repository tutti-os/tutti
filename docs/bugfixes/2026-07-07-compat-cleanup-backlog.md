# 2026-07-07 Compatibility Cleanup Backlog

> Status: active backlog.
>
> This document records compatibility and deprecation cleanup audits by code
> slice. Use `cleanup-now` only for migration residue that can no longer be
> triggered. Do not treat `legacy` fixture names or historical test labels as
> cleanup work by themselves.

## Classification

- `required-compat`: compatibility code that still protects an upgrade path,
  a public wire contract, downgrade behavior, or a known historical schema.
- `cleanup-now`: compatibility residue confirmed unreachable by supported
  upgrade paths and safe to remove in the current slice.
- `follow-up`: cleanup that needs a wider product, API, supported-version, or
  ownership decision before code should change.

## CC-03: services/tuttid/data/workspace

Scope:

- `services/tuttid/data/workspace/**`
- Baseline: `origin/main @ 85de7cbaf`
- Branch: `refactor/cc-03-data-workspace-compat`
- Audit date: 2026-07-08

### cleanup-now

No cleanup-now items confirmed.

### required-compat

- Agent target legacy ID reconciliation in
  `services/tuttid/data/workspace/agent_store.go` remains required. The
  `local-codex` and `local-claude-code` aliases are passed to the extracted
  `packages/agent/store-sqlite` migration layer so old system target rows and
  session references can be rewritten to `local:codex` and
  `local:claude-code`.
- Agent session target backfill by provider in
  `services/tuttid/data/workspace/agent_store.go` remains required. Historical
  sessions can have an empty `agent_target_id`; target-scoped section queries
  filter by `agent_target_id`, so the backfill protects old Codex, Claude Code,
  and Cursor sessions from disappearing from provider-scoped lists.
- The extracted agent store migration claim path remains required. Existing
  databases can carry agent migration markers in `tuttid_schema_migrations`;
  those markers are claimed into `agent_store_schema_migrations` rather than
  replaying old migrations. Tests intentionally verify that v5 target-ID and
  rail backfills do not replay for already-migrated databases.
- Desktop preference migration from
  `prevent_sleep_while_agent_running_enabled` to `sleep_prevention_mode`
  remains required for pre-mode desktop preference rows.
- Desktop composer default backfill from
  `agent_composer_defaults_by_provider_json` to
  `agent_composer_defaults_by_agent_target_json` remains required. The new
  agent-target keyed column owns runtime defaults after migration, but the
  provider-keyed column is still part of the public desktop preferences wire
  contract and is frozen for compatibility.
- Workspace issue topic migration and default-topic repair remain required.
  The v3 migration handles old issue schemas without `topic_id`, and the
  marker repair path handles databases where the v3 schema is present but the
  migration record is missing.
- Workspace issue run and app factory job `agent_target_id` migrations remain
  required for historical rows that only stored `agent_provider` / `provider`.

### follow-up

- Retiring `AgentComposerDefaultsByProvider` requires a wider API and desktop
  contract decision. It is still exposed in OpenAPI, generated clients,
  desktop preference events, and desktop-side compatibility surfaces.
- Retiring `local-codex` / `local-claude-code` alias reconciliation requires a
  supported database-version or supported-upgrade-window decision.
- Removing historical issue-topic schema repair requires a decision that
  databases before `workspace_issues_v3` and databases with a missing v3 marker
  are no longer supported.
- Removing provider-to-target backfills for `workspace_issue_runs` or
  `app_factory_jobs` requires a supported database-version decision for rows
  created before agent targets were recorded.

### Verification

Audit validation:

```sh
cd services/tuttid && go test ./data/workspace
```

Result: passed on 2026-07-08.
