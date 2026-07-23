package workspace

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const schemaMigrationWorkspacesV1 = "workspaces_v1"
const schemaMigrationWorkspacesV2 = "workspaces_v2"
const schemaMigrationWorkspacesV3 = "workspaces_v3"
const schemaMigrationWorkspacesV4 = "workspaces_v4"
const schemaMigrationWorkspaceWorkbenchAgentGUIUnifiedDockV1 = "workspace_workbench_agent_gui_unified_dock_v1"
const schemaMigrationWorkspaceWorkbenchAgentTargetIdentityV1 = "workspace_workbench_agent_target_identity_v1"
const schemaMigrationWorkspaceIssuesV1 = "workspace_issues_v1"
const schemaMigrationWorkspaceIssuesV2 = "workspace_issues_v2"
const schemaMigrationWorkspaceIssuesV3 = "workspace_issues_v3"
const schemaMigrationWorkspaceIssuesV4 = "workspace_issues_v4"
const schemaMigrationWorkspaceIssuesV5 = "workspace_issues_v5"
const schemaMigrationWorkspaceAgentsV1 = "workspace_agents_v1"
const schemaMigrationWorkspaceAgentsV2 = "workspace_agents_model_fallbacks_v1"
const schemaMigrationWorkspaceAgentsV3 = "workspace_agents_call_conditions_v1"
const schemaMigrationWorkspaceAgentsV4 = "workspace_agents_capability_selection_v1"
const schemaMigrationWorkspaceIssuesV12 = "workspace_issue_tasks_launch_overrides_v1"
const schemaMigrationWorkspaceIssuesV13 = "workspace_issue_tasks_parallelizable_v1"
const schemaMigrationWorkspaceIssuesV14 = "workspace_issues_plan_origin_v1"
const schemaMigrationWorkspaceIssuesV15 = "workspace_issues_execution_lifecycle_v1"
const schemaMigrationWorkspaceIssuesV16 = "workspace_issue_tasks_auto_accept_v1"
const schemaMigrationDesktopPreferencesV1 = "desktop_preferences_v1"
const schemaMigrationDesktopPreferencesAgentDockLayoutV1 = "desktop_preferences_agent_dock_layout_v1"
const schemaMigrationDesktopPreferencesSleepPreventionModeV1 = "desktop_preferences_sleep_prevention_mode_v1"
const schemaMigrationDesktopPreferencesDockPlacementV1 = "desktop_preferences_dock_placement_v1"
const schemaMigrationDesktopPreferencesDockIconStyleV1 = "desktop_preferences_dock_icon_style_v1"
const schemaMigrationDesktopPreferencesDefaultAgentProviderV1 = "desktop_preferences_default_agent_provider_v1"
const schemaMigrationDesktopPreferencesAgentComposerDefaultsV1 = "desktop_preferences_agent_composer_defaults_v1"
const schemaMigrationDesktopPreferencesAgentComposerDefaultsByAgentTargetV1 = "desktop_preferences_agent_composer_defaults_by_agent_target_v1"
const schemaMigrationDesktopPreferencesAgentGUIConversationRailV1 = "desktop_preferences_agent_gui_conversation_rail_v1"
const schemaMigrationDesktopPreferencesBrowserUseConnectionModeV1 = "desktop_preferences_browser_use_connection_mode_v1"
const schemaMigrationDesktopPreferencesUpdateSettingsV1 = "desktop_preferences_update_settings_v1"
const schemaMigrationDesktopPreferencesFileDefaultOpenersV1 = "desktop_preferences_file_default_openers_v1"
const schemaMigrationDesktopPreferencesAppCatalogChannelV1 = "desktop_preferences_app_catalog_channel_v1"
const schemaMigrationDesktopPreferencesMinimizeAnimationV1 = "desktop_preferences_minimize_animation_v1"
const schemaMigrationDesktopPreferencesWindowSnappingV1 = "desktop_preferences_window_snapping_v1"
const schemaMigrationDesktopPreferencesShowAppDeveloperSourcesV1 = "desktop_preferences_show_app_developer_sources_v1"
const schemaMigrationDesktopPreferencesAgentConversationDetailModeV1 = "desktop_preferences_agent_conversation_detail_mode_v1"
const schemaMigrationDesktopPreferencesFeatureFlagsV1 = "desktop_preferences_feature_flags_v1"
const schemaMigrationDesktopPreferencesDeletedAgentRetentionV1 = "desktop_preferences_deleted_agent_retention_v1"
const schemaMigrationDesktopPreferencesAgentCLIUpdateCheckV1 = "desktop_preferences_agent_cli_update_check_v1"
const schemaMigrationAgentDataMaintenanceV1 = "agent_data_maintenance_v1"
const schemaMigrationUserProjectsV1 = "user_projects_v1"
const schemaMigrationUserProjectsV2 = "user_projects_v2"
const schemaMigrationUserProjectsV3 = "user_projects_v3"
const schemaMigrationAgentQuickPromptsV1 = "agent_quick_prompts_v1"
const schemaMigrationAgentQuickPromptsV2 = "agent_quick_prompts_v2"
const schemaMigrationWorkspaceAppsV1 = "workspace_apps_v1"
const schemaMigrationWorkspaceAppsV2 = "workspace_apps_v2"
const schemaMigrationWorkspaceAppsV3 = "workspace_apps_v3"
const schemaMigrationManagedCredentialsV1 = "managed_credentials_v1"
const schemaMigrationModelPlansV1 = "model_plans_v1"
const schemaMigrationModelPlanFirstUseCandidatesV1 = "model_plan_first_use_candidates_v1"
const schemaMigrationAgentModelBindingsV1 = "agent_model_bindings_v1"
const schemaMigrationAgentModelBindingsV2 = "agent_model_bindings_v2"
const schemaMigrationAgentModelBindingsV3 = "agent_model_bindings_v3"
const schemaMigrationWorkspaceAgentsV5 = "workspace_agents_contract_cleanup_v1"
const schemaMigrationCollabRunsV1 = "collab_runs_v1"
const schemaMigrationModelPlanRevisionsV1 = "model_plan_revisions_v1"
const schemaMigrationAppFactoryJobsV1 = "app_factory_jobs_v1"
const schemaMigrationAppFactoryJobsV2 = "app_factory_jobs_v2"
const schemaMigrationAppFactoryJobsV3 = "app_factory_jobs_v3"
const schemaMigrationWorkspaceWorkflowsV1 = "workspace_workflows_v1"
const schemaMigrationWorkspaceWorkflowMutationsV2 = "workspace_workflow_mutations_v2"
const schemaMigrationWorkspaceWorkflowRevisionPathReuseV3 = "workspace_workflow_revision_path_reuse_v3"
const schemaMigrationTuttiModeActivationsV1 = "tutti_mode_activations_v1"
const schemaMigrationTuttiModeTurnDispatchV2 = "tutti_mode_turn_dispatch_v2"
const schemaMigrationTuttiModeOrchestrationIntensityV3 = "tutti_mode_orchestration_intensity_v3"
const schemaMigrationWorkspaceWorkflowTaskAssignmentsV4 = "workspace_workflow_task_assignments_v4"

func (s *SQLiteStore) Migrate(ctx context.Context) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}

	_, err := s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at
  ON workspaces(updated_at_unix_ms DESC);

INSERT OR IGNORE INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspacesV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate workspace database: %w", err)
	}

	if err := s.applyWorkspacesV2(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspacesV3(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspacesV4(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceWorkbenchAgentGUIUnifiedDockV1(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceIssuesV1(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceIssuesV2(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceIssuesV3(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceIssuesV4(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceIssuesV5(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceIssuesV12(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceIssuesV13(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceIssuesV14(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceIssuesV15(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceIssuesV16(ctx); err != nil {
		return err
	}

	if err := s.applyDesktopPreferencesV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesAgentDockLayoutV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesSleepPreventionModeV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesDockPlacementV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesDockIconStyleV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesDefaultAgentProviderV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesAgentComposerDefaultsV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesAgentComposerDefaultsByAgentTargetV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesAgentGUIConversationRailV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesBrowserUseConnectionModeV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesUpdateSettingsV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesFileDefaultOpenersV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesAppCatalogChannelV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesMinimizeAnimationV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesWindowSnappingV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesShowAppDeveloperSourcesV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesAgentConversationDetailModeV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesFeatureFlagsV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesDeletedAgentRetentionV1(ctx); err != nil {
		return err
	}
	if err := s.applyDesktopPreferencesAgentCLIUpdateCheckV1(ctx); err != nil {
		return err
	}
	if err := s.applyAgentDataMaintenanceV1(ctx); err != nil {
		return err
	}

	if err := s.applyUserProjectsV1(ctx); err != nil {
		return err
	}
	if err := s.applyUserProjectsV2(ctx); err != nil {
		return err
	}
	if err := s.applyUserProjectsV3(ctx); err != nil {
		return err
	}
	if err := s.applyAgentQuickPromptsV1(ctx); err != nil {
		return err
	}
	if err := s.applyAgentQuickPromptsV2(ctx); err != nil {
		return err
	}

	// Agent activity and agent target migrations live in the embedded agent
	// store. They must run after user_projects_v1: the rail section backfill
	// reads project paths through userProjectPathsQuerier.
	if err := s.agentStore().Migrate(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceWorkbenchAgentTargetIdentityV1(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceAppsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAppsV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAppsV3(ctx); err != nil {
		return err
	}
	if err := s.applyManagedCredentialsV1(ctx); err != nil {
		return err
	}
	if err := s.applyModelPlansV1(ctx); err != nil {
		return err
	}
	if err := s.applyModelPlanFirstUseCandidatesV1(ctx); err != nil {
		return err
	}
	if err := s.applyModelPlanRevisionsV1(ctx); err != nil {
		return err
	}
	if err := s.applyAgentModelBindingsV1(ctx); err != nil {
		return err
	}
	if err := s.applyAgentModelBindingsV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentsV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentsV3(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentsV4(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentsV5(ctx); err != nil {
		return err
	}

	if err := s.applyCollabRunsV1(ctx); err != nil {
		return err
	}
	if err := s.applyModelPoliciesV1(ctx); err != nil {
		return err
	}
	if err := s.applyAutomationRulesV1(ctx); err != nil {
		return err
	}
	if err := s.applyAutomationRulesV2(ctx); err != nil {
		return err
	}
	// Runs after model_usage_policies exists so the bindings table can gain a
	// foreign key referencing it.
	if err := s.applyAgentModelBindingsV3(ctx); err != nil {
		return err
	}
	if err := s.applyAppFactoryJobsV1(ctx); err != nil {
		return err
	}
	if err := s.applyAppFactoryJobsV2(ctx); err != nil {
		return err
	}
	if err := s.applyAppFactoryJobsV3(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceWorkflowsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceWorkflowMutationsV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceWorkflowRevisionPathReuseV3(ctx); err != nil {
		return err
	}
	if err := s.applyTuttiModeActivationsV1(ctx); err != nil {
		return err
	}
	if err := s.applyTuttiModeTurnDispatchV2(ctx); err != nil {
		return err
	}
	if err := s.applyTuttiModeOrchestrationIntensityV3(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceWorkflowTaskAssignmentsV4(ctx); err != nil {
		return err
	}
	return s.openReadPool(ctx)
}

func (s *SQLiteStore) applyWorkspacesV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspacesV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
ALTER TABLE workspaces ADD COLUMN last_opened_at_unix_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened_at
  ON workspaces(last_opened_at_unix_ms DESC);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspacesV2, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database to v2: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyWorkspacesV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspacesV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_workbench_snapshots (
  workspace_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspacesV3, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database to v3: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyWorkspacesV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspacesV4)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasLocalPath, err := s.hasColumn(ctx, "workspaces", "local_path")
	if err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	if !hasLocalPath {
		_, err = s.writeDB.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened_at
  ON workspaces(last_opened_at_unix_ms DESC);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspacesV4, now)
		if err != nil {
			return fmt.Errorf("migrate workspace database to v4: %w", err)
		}
		return nil
	}

	if _, err := s.writeDB.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("disable sqlite foreign keys for workspace v4 migration: %w", err)
	}
	defer func() {
		_, _ = s.writeDB.ExecContext(context.Background(), `PRAGMA foreign_keys = ON`)
	}()

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace database v4 migration: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	_, err = tx.ExecContext(ctx, `
DROP INDEX IF EXISTS idx_workspaces_local_path_unique;
DROP INDEX IF EXISTS idx_workspaces_updated_at;
DROP INDEX IF EXISTS idx_workspaces_last_opened_at;
CREATE TABLE workspaces_v4 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_opened_at_unix_ms INTEGER
);
INSERT INTO workspaces_v4 (id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms)
SELECT id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms
FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_v4 RENAME TO workspaces;
CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at
  ON workspaces(updated_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened_at
  ON workspaces(last_opened_at_unix_ms DESC);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspacesV4, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database to v4: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace database v4 migration: %w", err)
	}

	if _, err := s.writeDB.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		return fmt.Errorf("re-enable sqlite foreign keys for workspace v4 migration: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyWorkspaceIssuesV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  task_count INTEGER NOT NULL DEFAULT 0,
  not_started_count INTEGER NOT NULL DEFAULT 0,
  running_count INTEGER NOT NULL DEFAULT 0,
  pending_acceptance_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  canceled_count INTEGER NOT NULL DEFAULT 0,
  creator_user_id TEXT NOT NULL DEFAULT '',
  creator_display_name TEXT NOT NULL DEFAULT '',
  creator_avatar_url TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_issues_workspace_updated
  ON workspace_issues(workspace_id, updated_at_unix_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_issues_workspace_status
  ON workspace_issues(workspace_id, status);

CREATE TABLE IF NOT EXISTS workspace_issue_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  due_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  creator_user_id TEXT NOT NULL DEFAULT '',
  creator_display_name TEXT NOT NULL DEFAULT '',
  creator_avatar_url TEXT NOT NULL DEFAULT '',
  latest_run_id TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_issue_tasks_issue_sort
  ON workspace_issue_tasks(workspace_id, issue_id, sort_index ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_workspace_issue_tasks_issue_status
  ON workspace_issue_tasks(workspace_id, issue_id, status);

CREATE TABLE IF NOT EXISTS workspace_issue_context_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_ref_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  parent_kind TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, context_ref_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_issue_context_refs_parent
  ON workspace_issue_context_refs(workspace_id, issue_id, task_id, parent_kind, created_at_unix_ms ASC, id ASC);

CREATE TABLE IF NOT EXISTS workspace_issue_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL DEFAULT '',
  agent_user_id TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT NOT NULL DEFAULT '',
  agent_session_id TEXT NOT NULL DEFAULT '',
  agent_provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  output_dir TEXT NOT NULL DEFAULT '',
  execution_directory TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id, run_id),
  FOREIGN KEY (workspace_id, issue_id, task_id) REFERENCES workspace_issue_tasks(workspace_id, issue_id, task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_issue_runs_task_created
  ON workspace_issue_runs(workspace_id, issue_id, task_id, created_at_unix_ms DESC, id DESC);

CREATE TABLE IF NOT EXISTS workspace_issue_run_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id, run_id, output_id),
  FOREIGN KEY (workspace_id, issue_id, task_id, run_id) REFERENCES workspace_issue_runs(workspace_id, issue_id, task_id, run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_issue_run_outputs_run
  ON workspace_issue_run_outputs(workspace_id, issue_id, task_id, run_id, created_at_unix_ms ASC, id ASC);

CREATE TRIGGER IF NOT EXISTS trg_workspace_issue_tasks_delete_context_refs
AFTER DELETE ON workspace_issue_tasks
BEGIN
  DELETE FROM workspace_issue_context_refs
  WHERE workspace_id = OLD.workspace_id
    AND issue_id = OLD.issue_id
    AND task_id = OLD.task_id
    AND parent_kind = 'task';
END;

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for issue manager: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyWorkspaceIssuesV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
PRAGMA foreign_keys = OFF;

ALTER TABLE workspace_issue_run_outputs RENAME TO workspace_issue_run_outputs_v1;
ALTER TABLE workspace_issue_runs RENAME TO workspace_issue_runs_v1;
DROP INDEX IF EXISTS idx_workspace_issue_runs_task_created;
DROP INDEX IF EXISTS idx_workspace_issue_run_outputs_run;

CREATE TABLE workspace_issue_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL DEFAULT '',
  agent_user_id TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT NOT NULL DEFAULT '',
  agent_session_id TEXT NOT NULL DEFAULT '',
  agent_provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  output_dir TEXT NOT NULL DEFAULT '',
  execution_directory TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id, run_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES workspace_issues(workspace_id, issue_id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_issue_runs_task_created
  ON workspace_issue_runs(workspace_id, issue_id, task_id, created_at_unix_ms DESC, id DESC);

INSERT INTO workspace_issue_runs (
  id, run_id, task_id, issue_id, workspace_id, requester_user_id, agent_user_id,
  agent_target_id, agent_session_id, agent_provider, status, summary,
  error_message, output_dir, execution_directory, created_at_unix_ms,
  started_at_unix_ms, completed_at_unix_ms, updated_at_unix_ms
)
SELECT
  id, run_id, task_id, issue_id, workspace_id, requester_user_id, agent_user_id,
  '', agent_session_id, agent_provider, status, summary, error_message,
  output_dir, '', created_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  updated_at_unix_ms
FROM workspace_issue_runs_v1;

CREATE TABLE workspace_issue_run_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, issue_id, task_id, run_id, output_id),
  FOREIGN KEY (workspace_id, issue_id, task_id, run_id) REFERENCES workspace_issue_runs(workspace_id, issue_id, task_id, run_id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_issue_run_outputs_run
  ON workspace_issue_run_outputs(workspace_id, issue_id, task_id, run_id, created_at_unix_ms ASC, id ASC);

INSERT INTO workspace_issue_run_outputs (
  id, output_id, run_id, task_id, issue_id, workspace_id, path, display_name,
  media_type, size_bytes, created_at_unix_ms
)
SELECT
  id, output_id, run_id, task_id, issue_id, workspace_id, path, display_name,
  media_type, size_bytes, created_at_unix_ms
FROM workspace_issue_run_outputs_v1;

DROP TABLE workspace_issue_run_outputs_v1;
DROP TABLE workspace_issue_runs_v1;

PRAGMA foreign_keys = ON;

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV2, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for issue manager v2: %w", err)
	}

	return nil
}

// applyWorkspaceIssuesV12 introduces the task-level assignment and launch
// override fields recorded from the Tutti Mode plan review: per-task agent
// target, model plan, model, execution directory, dependency graph, permission
// mode, and reasoning effort. Empty values inherit the target default and the
// Issue-level intensity. The migration is additive so existing local Issue
// Manager data remains valid.
func (s *SQLiteStore) applyWorkspaceIssuesV12(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV12)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	columns := []struct {
		name       string
		definition string
	}{
		{"agent_target_id", "TEXT NOT NULL DEFAULT ''"},
		{"model_plan_id", "TEXT NOT NULL DEFAULT ''"},
		{"model", "TEXT NOT NULL DEFAULT ''"},
		{"execution_directory", "TEXT NOT NULL DEFAULT ''"},
		{"dependency_task_ids_json", "TEXT NOT NULL DEFAULT '[]'"},
		{"permission_mode_id", "TEXT NOT NULL DEFAULT ''"},
		{"reasoning_effort", "TEXT NOT NULL DEFAULT ''"},
	}
	for _, column := range columns {
		hasColumn, err := s.hasColumn(ctx, "workspace_issue_tasks", column.name)
		if err != nil {
			return err
		}
		if hasColumn {
			continue
		}
		statement := fmt.Sprintf("ALTER TABLE workspace_issue_tasks ADD COLUMN %s %s;", column.name, column.definition)
		if _, err := s.writeDB.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add workspace_issue_tasks.%s: %w", column.name, err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV12, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue task launch overrides migration: %w", err)
	}
	return nil
}

// applyWorkspaceIssuesV13 records the per-task parallel opt-in from the Tutti
// Mode plan review. Sequential stays the default: false means the task waits
// for its predecessors, true lets it run alongside other ready tasks.
func (s *SQLiteStore) applyWorkspaceIssuesV13(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssuesV13)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	hasColumn, err := s.hasColumn(ctx, "workspace_issue_tasks", "parallelizable")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := s.writeDB.ExecContext(ctx, "ALTER TABLE workspace_issue_tasks ADD COLUMN parallelizable INTEGER NOT NULL DEFAULT 0;"); err != nil {
			return fmt.Errorf("add workspace_issue_tasks.parallelizable: %w", err)
		}
	}
	if _, err := s.writeDB.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceIssuesV13, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace issue task parallelizable migration: %w", err)
	}
	return nil
}
