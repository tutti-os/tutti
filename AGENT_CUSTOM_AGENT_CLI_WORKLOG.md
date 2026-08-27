# Custom Agent CLI Work Log

This is an uncommitted implementation log for Issue #2412. It intentionally
stays outside the commit history unless the user explicitly requests a commit.

## Objective

1. Make GUI-created custom Agents discoverable through `tutti agent list` or an
   equivalent discovery command.
2. Ensure the discovered exact ID can be consumed by `composer-options`,
   `agent start`, Issue runs, and Plan tasks as `agentTargetId`.

## Confirmed Current State

- Custom Agent identity is generated as `workspace-agent:<uuid>` in
  `services/tuttid/service/workspaceagent/service.go`.
- The identity is persisted in `workspace_agents.agent_id`, scoped by
  `workspace_id`.
- GUI listing uses `WorkspaceAgentService.List(workspaceID)`.
- CLI `agent list` currently reads only `AgentTargetService.List()`.
- CLI selector resolution currently reads only enabled Agent Targets.
- Session creation already recognizes the `workspace-agent:` prefix and calls
  `WorkspaceAgentResolver.Resolve(workspaceID, agentID)`.
- The critical missing link is CLI discovery/selection plus explicit workspace
  propagation.

## Design Decisions

- `apps/cli` remains a thin daemon client and never opens SQLite.
- `tuttid` combines Agent Target data and workspace custom-Agent data.
- A custom Agent is returned only with explicit workspace context.
- No startup-workspace fallback is used for custom-Agent IDs.
- The exact custom ID remains the launch identity; the harness ID is derived
  runtime metadata.
- Event-driven projection and materialized views are deferred.

## Implementation Checkpoints

- [x] Add the workspace-agent catalog dependency at the `tuttid` CLI boundary.
- [x] Thread `InvokeContext.WorkspaceID` into Agent list and selector resolution.
- [x] Project workspace Agents into the CLI discovery response.
- [x] Resolve custom IDs for composer options, skill bundle, and start.
- [ ] Verify Issue and Plan preserve and dispatch the exact ID.
- [ ] Add focused regression tests for workspace isolation and unavailable
  harnesses.
- [ ] Run selected validation commands and record results here.

## Validation Notes

Validation completed so far:

- Added `TestAgentListIncludesWorkspaceCustomAgentWithWorkspaceContext`.
- The test failed before implementation because `Provider` had no workspace
  Agent catalog hook.
- After implementation, `go test ./service/cli/providers/agentcontext` passes.
- No code or documentation in this work log has been committed.

- Added `TestCustomAgentSelectorsPreserveWorkspaceAndExactID` covering both
  `agent start` and `composer-options`; focused package tests pass.

- Audited `packages/workspace/issues`: task creation preserves the supplied
  `AgentTargetID`, and run preparation prefers that exact ID before legacy
  provider fallback. No production change was needed in the Issue path.

- Added `TestServiceCreateRunPreservesWorkspaceAgentTargetID`; the Issue
  service package passes with `go test .`.

- Extended custom `agent list --json` entries with optional `kind` and
  `harnessAgentTargetId` metadata without changing the existing schema version.
  The CLI package tests pass.

## Final Audit

- `git diff --check` reports no whitespace errors.
- Windows impact: this change only routes explicit workspace IDs and serializes
  catalog metadata; it does not alter paths, processes, shells, permissions, or
  platform-specific adapters.
- Existing unrelated worktree modifications remain untouched.
- No commit was created.

- Added workspace isolation and unavailable-harness regression coverage.
- Custom Agent selector resolution now fails closed when the harness is disabled
  or unavailable, before session creation.

Additional checkpoint:

- Fixed exact-ID filtering in `agent list` so workspace custom IDs are resolved
  after workspace catalog loading instead of being rejected as global targets.
- Added `TestAgentListFiltersWorkspaceCustomAgentByExactID`; focused package
  tests pass.
- `go test .` compiles the daemon root but currently fails in the pre-existing
  Claude Code runtime-start test because the local Node/SDK runtime cannot
  start. This is recorded as an environment baseline failure, not a catalog
  assertion failure.
