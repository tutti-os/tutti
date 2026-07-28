package workspace

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
	executionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

var tuttiModeExecutionTables = []string{
	"workspace_tutti_executions",
	"workspace_tutti_execution_checkpoints",
	"workspace_tutti_execution_wakes",
	"workspace_tutti_goal_reviews",
	"workspace_tutti_source_activity_inbox",
	"workspace_tutti_archive_operations",
	"workspace_tutti_execution_mutations",
	"workspace_source_session_deletion_admissions",
	"workspace_issue_run_launch_intents",
	"workspace_issue_run_cancel_compensations",
}

func TestTuttiModeExecutionMigrationCreatesForwardCompatibleSchema(t *testing.T) {
	t.Parallel()
	store := openTuttiModeExecutionStore(t)
	ctx := context.Background()

	for _, table := range tuttiModeExecutionTables {
		var count int
		if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?
`, table).Scan(&count); err != nil {
			t.Fatalf("inspect table %q error = %v", table, err)
		}
		if count != 1 {
			t.Fatalf("table %q count = %d, want 1", table, count)
		}
	}
	for table, columns := range map[string][]string{
		"workspace_tutti_executions": {
			"graph_revision", "watchdog_due_at_unix_ms", "last_orchestrator_activity_at_unix_ms",
		},
		"workspace_tutti_execution_wakes": {
			"lease_owner", "lease_expires_at_unix_ms", "attempt_count", "client_submit_id",
		},
		"workspace_tutti_archive_operations": {
			"lease_owner", "lease_expires_at_unix_ms", "attempt_count",
		},
		"workspace_issue_run_launch_intents": {
			"lease_owner", "lease_expires_at_unix_ms", "attempt_count", "client_submit_id",
		},
		"workspace_issue_run_cancel_compensations": {
			"lease_owner", "lease_expires_at_unix_ms", "attempt_count", "client_submit_id",
		},
	} {
		for _, column := range columns {
			if !sqliteTableHasColumn(t, store, table, column) {
				t.Fatalf("table %q missing forward-compatible column %q", table, column)
			}
		}
	}
}

func TestTuttiModeRunCancelCompensationMigrationUpgradesV1Idempotently(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "cancel-compensation-upgrade.sqlite")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(initial) error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
DROP TABLE workspace_issue_run_cancel_compensations;
DELETE FROM tuttid_schema_migrations WHERE id = ?;
`, schemaMigrationWorkspaceTuttiModeRunCancelCompensationV2); err != nil {
		t.Fatalf("prepare V1 schema error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(V1 to V2) error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(V2 replay) error = %v", err)
	}
	var tableCount, migrationCount int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'table' AND name = 'workspace_issue_run_cancel_compensations'
`).Scan(&tableCount); err != nil {
		t.Fatalf("inspect compensation table error = %v", err)
	}
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceTuttiModeRunCancelCompensationV2).Scan(&migrationCount); err != nil {
		t.Fatalf("inspect compensation migration error = %v", err)
	}
	if tableCount != 1 || migrationCount != 1 {
		t.Fatalf(
			"V2 table/migration counts = %d/%d, want 1/1",
			tableCount, migrationCount,
		)
	}
}

func TestTuttiModeSourceActivityInboxMigrationUpgradesV2Idempotently(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	if _, err := store.writeDB.ExecContext(ctx, `
DROP TABLE workspace_tutti_source_activity_inbox;
DELETE FROM tuttid_schema_migrations WHERE id = ?;
`, schemaMigrationWorkspaceTuttiModeSourceActivityInboxV3); err != nil {
		t.Fatalf("prepare V2 schema error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(V2 to V3) error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(V3 replay) error = %v", err)
	}
	var tableCount, migrationCount int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master
WHERE type = 'table' AND name = 'workspace_tutti_source_activity_inbox'
`).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceTuttiModeSourceActivityInboxV3).Scan(
		&migrationCount,
	); err != nil {
		t.Fatal(err)
	}
	if tableCount != 1 || migrationCount != 1 {
		t.Fatalf(
			"V3 table/migration counts = %d/%d, want 1/1",
			tableCount, migrationCount,
		)
	}
}

func TestTuttiModeExecutionMigrationUpgradesExistingWorkspaceDatabase(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "upgrade.sqlite")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(initial) error = %v", err)
	}
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-upgrade", Name: "Upgrade"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	if err := dropTuttiModeExecutionMigrationForUpgradeTest(ctx, store); err != nil {
		t.Fatalf("prepare pre-execution schema error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close(initial) error = %v", err)
	}

	upgraded, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore(upgrade) error = %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })
	if err := upgraded.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(upgrade) error = %v", err)
	}
	if _, err := upgraded.Get(ctx, "workspace-upgrade"); err != nil {
		t.Fatalf("Get() preserved workspace error = %v", err)
	}
	for _, table := range tuttiModeExecutionTables {
		var count int
		if err := upgraded.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?
`, table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("upgraded table %q count=%d error=%v", table, count, err)
		}
	}
}

func TestTuttiModeLegacyMigrationBackfillsDeterministicallyWithoutInventingSources(
	t *testing.T,
) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_000_000).UTC()
	type fixture struct {
		name        string
		sourceState string
		running     bool
		workspaceID string
		workflowID  string
		sourceID    string
		issueID     string
		runID       string
	}
	fixtures := []fixture{
		{
			name: "active-run", sourceState: "active", running: true,
			workspaceID: "workspace-legacy-active", workflowID: "workflow-legacy-active",
			sourceID: "source-legacy-active",
		},
		{
			name: "idle", sourceState: "active",
			workspaceID: "workspace-legacy-idle", workflowID: "workflow-legacy-idle",
			sourceID: "source-legacy-idle",
		},
		{
			name: "missing", sourceState: "missing",
			workspaceID: "workspace-legacy-missing", workflowID: "workflow-legacy-missing",
			sourceID: "source-legacy-missing",
		},
		{
			name: "tombstoned", sourceState: "tombstoned",
			workspaceID: "workspace-legacy-tombstoned", workflowID: "workflow-legacy-tombstoned",
			sourceID: "source-legacy-tombstoned",
		},
	}
	for index := range fixtures {
		value := &fixtures[index]
		prepareTuttiModeExecutionWorkspace(
			t, store, value.workspaceID, value.workflowID, value.sourceID, now,
		)
		if value.sourceState != "missing" {
			if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
				WorkspaceID: value.workspaceID, AgentSessionID: value.sourceID,
				Provider: "codex", Status: "completed", OccurredAtUnixMS: now.UnixMilli(),
			}); err != nil {
				t.Fatalf("%s: ReportSessionState() error = %v", value.name, err)
			}
			if value.sourceState == "tombstoned" {
				if _, err := store.AgentCanonicalStore().DeleteSession(
					ctx, value.workspaceID, value.sourceID,
				); err != nil {
					t.Fatalf("%s: DeleteSession() error = %v", value.name, err)
				}
			}
		}
		issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
		issue, tasks := prepareTuttiModeIssueGraph(
			t, issues, value.workspaceID, value.workflowID, value.sourceID,
		)
		if value.running {
			tasks[0].AutoAccept = true
		}
		executions := &executionservice.Service{
			Store: store, Clock: func() time.Time { return now },
		}
		created, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: value.workflowID,
		})
		if err != nil {
			t.Fatalf("%s: Materialize() error = %v", value.name, err)
		}
		value.issueID = created.IssueID
		if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM workspace_tutti_executions
WHERE workspace_id = ? AND issue_id = ?
`, value.workspaceID, value.issueID); err != nil {
			t.Fatalf("%s: delete execution fixture error = %v", value.name, err)
		}
		if value.running {
			run, err := issues.CreateRun(ctx, workspaceissues.CreateRunInput{
				RunID: "legacy-running-run", TaskID: "task-1",
				IssueID: value.issueID, WorkspaceID: value.workspaceID,
				ActorUserID: "legacy", AgentTargetID: "local:codex",
				AgentSessionID: "legacy-running-session",
			})
			if err != nil {
				t.Fatalf("%s: CreateRun() error = %v", value.name, err)
			}
			value.runID = run.RunID
		}
	}

	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations
WHERE id = ?
`, schemaMigrationWorkspaceTuttiModeLegacyRepairV5); err != nil {
		t.Fatalf("prepare legacy migration marker error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(legacy repair) error = %v", err)
	}
	for _, value := range fixtures {
		aggregate, err := store.GetTuttiModeExecutionByIssue(
			ctx, value.workspaceID, value.issueID,
		)
		if err != nil {
			t.Fatalf("%s: GetTuttiModeExecutionByIssue() error = %v", value.name, err)
		}
		executionID, _ := executionbiz.ExecutionID(value.issueID)
		checkpointID, _ := executionbiz.MigrationCheckpointID(executionID)
		if aggregate.Execution.ID != executionID ||
			len(aggregate.Checkpoints) != 1 ||
			aggregate.Checkpoints[0].ID != checkpointID ||
			aggregate.Checkpoints[0].Kind != executionbiz.CheckpointKindMigration {
			t.Fatalf("%s: repaired aggregate = %#v", value.name, aggregate)
		}
		task, err := store.GetTask(ctx, value.workspaceID, value.issueID, "task-1")
		if err != nil {
			t.Fatalf("%s: GetTask() error = %v", value.name, err)
		}
		if value.running && !task.AutoAccept {
			t.Fatalf("%s: historical autoAccept was not preserved: %#v", value.name, task)
		}
		var sourceRows, wakeRows int
		if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, value.workspaceID, value.sourceID).Scan(&sourceRows); err != nil {
			t.Fatalf("%s: count source rows error = %v", value.name, err)
		}
		if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_tutti_execution_wakes
WHERE workspace_id = ? AND execution_id = ?
`, value.workspaceID, executionID).Scan(&wakeRows); err != nil {
			t.Fatalf("%s: count wakes error = %v", value.name, err)
		}
		switch {
		case value.sourceState == "active" && value.running:
			if aggregate.Execution.Status != executionbiz.StatusRunning ||
				aggregate.Checkpoints[0].Status != executionbiz.CheckpointStatusActive ||
				sourceRows != 1 || wakeRows != 1 {
				t.Fatalf("%s: active repair aggregate=%#v source/wakes=%d/%d", value.name, aggregate, sourceRows, wakeRows)
			}
			run, err := store.GetRun(
				ctx, value.workspaceID, value.issueID, "task-1", value.runID,
			)
			if err != nil || run.Status != workspaceissues.StatusRunning {
				t.Fatalf("%s: running Run=%#v error=%v", value.name, run, err)
			}
			var runCount, launchIntentCount int
			if err := store.writeDB.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM workspace_issue_runs
   WHERE workspace_id = ? AND issue_id = ?),
  (SELECT COUNT(*) FROM workspace_issue_run_launch_intents
   WHERE workspace_id = ? AND issue_id = ?)
`, value.workspaceID, value.issueID,
				value.workspaceID, value.issueID,
			).Scan(&runCount, &launchIntentCount); err != nil {
				t.Fatalf("%s: inspect preserved Run error = %v", value.name, err)
			}
			if runCount != 1 || launchIntentCount != 0 {
				t.Fatalf(
					"%s: migration dispatched successor: runs/intents=%d/%d",
					value.name, runCount, launchIntentCount,
				)
			}
		case value.sourceState == "active":
			if aggregate.Execution.Status != executionbiz.StatusAwaitingMain ||
				aggregate.Checkpoints[0].Status != executionbiz.CheckpointStatusActive ||
				sourceRows != 1 || wakeRows != 1 {
				t.Fatalf(
					"%s: idle repair aggregate=%#v source/wakes=%d/%d",
					value.name, aggregate, sourceRows, wakeRows,
				)
			}
		case value.sourceState == "missing":
			if aggregate.Execution.Status != executionbiz.StatusOrphanedSource ||
				aggregate.Checkpoints[0].Status != executionbiz.CheckpointStatusCanceled ||
				!aggregate.Execution.WatchdogDueAt.IsZero() ||
				sourceRows != 0 || wakeRows != 0 {
				t.Fatalf("%s: missing repair aggregate=%#v source/wakes=%d/%d", value.name, aggregate, sourceRows, wakeRows)
			}
		case value.sourceState == "tombstoned":
			if aggregate.Execution.Status != executionbiz.StatusOrphanedSource ||
				aggregate.Checkpoints[0].Status != executionbiz.CheckpointStatusCanceled ||
				!aggregate.Execution.WatchdogDueAt.IsZero() ||
				sourceRows != 1 || wakeRows != 0 {
				t.Fatalf("%s: tombstoned repair aggregate=%#v source/wakes=%d/%d", value.name, aggregate, sourceRows, wakeRows)
			}
		}
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(legacy repair replay) error = %v", err)
	}
	var executionCount, checkpointCount, wakeCount, migrationCount int
	for _, tableCount := range []struct {
		query string
		dest  *int
	}{
		{
			query: "SELECT COUNT(*) FROM workspace_tutti_executions",
			dest:  &executionCount,
		},
		{
			query: "SELECT COUNT(*) FROM workspace_tutti_execution_checkpoints",
			dest:  &checkpointCount,
		},
		{
			query: "SELECT COUNT(*) FROM workspace_tutti_execution_wakes",
			dest:  &wakeCount,
		},
		{
			query: "SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = '" +
				schemaMigrationWorkspaceTuttiModeLegacyRepairV5 + "'",
			dest: &migrationCount,
		},
	} {
		if err := store.writeDB.QueryRowContext(ctx, tableCount.query).Scan(tableCount.dest); err != nil {
			t.Fatal(err)
		}
	}
	if executionCount != 4 || checkpointCount != 4 || wakeCount != 2 ||
		migrationCount != 1 {
		t.Fatalf(
			"replayed legacy counts executions/checkpoints/wakes/migration=%d/%d/%d/%d",
			executionCount, checkpointCount, wakeCount, migrationCount,
		)
	}
}

func TestTuttiModeExecutionMaterializationIsAtomicAndReadable(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_000_000).UTC()
	prepareTuttiModeExecutionWorkspace(t, store, "workspace-atomic", "workflow-atomic", "session-atomic", now)
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(t, issues, "workspace-atomic", "workflow-atomic", "session-atomic")
	createdIssue, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-atomic",
	})
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	aggregate, err := executions.GetByIssue(ctx, issue.WorkspaceID, createdIssue.IssueID)
	if err != nil {
		t.Fatalf("GetByIssue() error = %v", err)
	}
	if aggregate.Execution.Status != executionbiz.StatusAwaitingSchedule ||
		aggregate.Execution.GraphRevision != 1 ||
		len(aggregate.Checkpoints) != 1 ||
		aggregate.Checkpoints[0].Kind != executionbiz.CheckpointKindInitialSchedule ||
		aggregate.Checkpoints[0].Status != executionbiz.CheckpointStatusActive {
		t.Fatalf("materialized aggregate = %#v", aggregate)
	}
	detail, err := issues.GetIssueDetail(ctx, issue.WorkspaceID, createdIssue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if len(detail.Tasks) != 1 || detail.Tasks[0].Status != workspaceissues.StatusNotStarted {
		t.Fatalf("materialized tasks = %#v", detail.Tasks)
	}
	runs, err := issues.ListRuns(ctx, issue.WorkspaceID, createdIssue.IssueID, "")
	if err != nil || len(runs) != 0 {
		t.Fatalf("materialized runs = %#v error=%v, want none", runs, err)
	}

	_, err = store.writeDB.ExecContext(ctx, `
INSERT INTO workspace_tutti_execution_checkpoints (
  workspace_id, execution_id, checkpoint_id, kind, status, sequence,
  graph_revision, creation_reason, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 'watchdog', 'active', 2, 1, 'duplicate active', ?, ?)
`, issue.WorkspaceID, aggregate.Execution.ID, "duplicate-active", now.UnixMilli(), now.UnixMilli())
	if err == nil {
		t.Fatal("duplicate active checkpoint insertion succeeded, want unique constraint")
	}
}

func TestPrepareTuttiModeMainWakeRejectsConflictingDurableIdentity(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_050_000).UTC()
	prepareTuttiModeExecutionWorkspace(
		t,
		store,
		"workspace-wake-integrity",
		"workflow-wake-integrity",
		"session-wake-integrity",
		now,
	)
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(
		t,
		issues,
		"workspace-wake-integrity",
		"workflow-wake-integrity",
		"session-wake-integrity",
	)
	_, _, aggregate, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-wake-integrity",
	})
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET target_session_id = 'conflicting-session'
WHERE workspace_id = ? AND execution_id = ?
`, issue.WorkspaceID, aggregate.Execution.ID); err != nil {
		t.Fatalf("corrupt wake identity error = %v", err)
	}

	tx, err := store.writeDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx() error = %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	err = prepareTuttiModeMainWakeTx(
		ctx,
		tx,
		issue.WorkspaceID,
		aggregate.Execution.ID,
		aggregate.Checkpoints[0],
		now,
	)
	if !errors.Is(err, executionbiz.ErrWakeIntegrity) {
		t.Fatalf("prepareTuttiModeMainWakeTx() error = %v, want ErrWakeIntegrity", err)
	}
}

func TestTuttiModeMainWakeImmutableSourceIdentityIsRelationallyProtected(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct {
		name  string
		query string
	}{
		{
			name: "workspace",
			query: `
UPDATE workspace_tutti_execution_wakes
SET workspace_id = 'corrupt-workspace'
WHERE workspace_id = ? AND execution_id = ?
`,
		},
		{
			name: "execution",
			query: `
UPDATE workspace_tutti_execution_wakes
SET execution_id = 'corrupt-execution'
WHERE workspace_id = ? AND execution_id = ?
`,
		},
		{
			name: "checkpoint",
			query: `
UPDATE workspace_tutti_execution_wakes
SET checkpoint_id = 'corrupt-checkpoint'
WHERE workspace_id = ? AND execution_id = ?
`,
		},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			store := openTuttiModeExecutionStore(t)
			now := time.UnixMilli(1_700_000_060_000).UTC()
			workspaceID := "workspace-wake-immutable-" + testCase.name
			workflowID := "workflow-wake-immutable-" + testCase.name
			sessionID := "session-wake-immutable-" + testCase.name
			prepareTuttiModeExecutionWorkspace(
				t, store, workspaceID, workflowID, sessionID, now,
			)
			executions := &executionservice.Service{
				Store: store,
				Clock: func() time.Time { return now },
			}
			issues := workspaceissues.Service{
				Store: store,
				Clock: func() time.Time { return now },
			}
			issue, tasks := prepareTuttiModeIssueGraph(
				t, issues, workspaceID, workflowID, sessionID,
			)
			_, _, aggregate, err := executions.Materialize(
				ctx,
				executionservice.MaterializeInput{
					Issue: issue, Tasks: tasks, WorkflowID: workflowID,
				},
			)
			if err != nil {
				t.Fatalf("Materialize() error = %v", err)
			}

			if _, err := store.writeDB.ExecContext(
				ctx, testCase.query, workspaceID, aggregate.Execution.ID,
			); err == nil {
				t.Fatalf("corrupt %s identity succeeded, want relational constraint", testCase.name)
			}
			var retained int
			if err := store.readDB.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM workspace_tutti_execution_wakes
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
`, workspaceID, aggregate.Execution.ID, aggregate.Checkpoints[0].ID).Scan(&retained); err != nil {
				t.Fatalf("query retained wake error = %v", err)
			}
			if retained != 1 {
				t.Fatalf("retained wakes = %d, want 1 unchanged row", retained)
			}
		})
	}
}

func TestTuttiModeCheckpointCommandsRollbackWhenActiveWakeIsClosed(t *testing.T) {
	t.Run("schedule", func(t *testing.T) {
		ctx := context.Background()
		store := openTuttiModeExecutionStore(t)
		now := time.UnixMilli(1_700_000_075_000).UTC()
		prepareTuttiModeExecutionWorkspace(
			t, store, "workspace-wake-schedule-fence", "workflow-wake-schedule-fence",
			"session-wake-schedule-fence", now,
		)
		executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
		issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
		issue, tasks := prepareTuttiModeIssueGraph(
			t, issues, "workspace-wake-schedule-fence", "workflow-wake-schedule-fence",
			"session-wake-schedule-fence",
		)
		_, _, aggregate, err := executions.Materialize(ctx, executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: "workflow-wake-schedule-fence",
		})
		if err != nil {
			t.Fatalf("Materialize() error = %v", err)
		}
		if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'canceled'
WHERE workspace_id = ? AND checkpoint_id = ?
`, issue.WorkspaceID, aggregate.Checkpoints[0].ID); err != nil {
			t.Fatalf("close active checkpoint wake error = %v", err)
		}
		run := tuttiModeScheduleTestRun(issue, tasks[0], "run-wake-schedule-fence", now)
		_, err = store.AdmitTuttiModeSchedule(ctx, executionbiz.ScheduleAdmission{
			WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
			SourceSessionID:       issue.SourceSessionID,
			CheckpointID:          aggregate.Checkpoints[0].ID,
			ExpectedGraphRevision: 1,
			RequestID:             "request-wake-schedule-fence",
			InputSHA256:           "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Runs:                  []workspaceissues.Run{run},
			Now:                   now,
		})
		if !errors.Is(err, executionbiz.ErrWakeRejected) {
			t.Fatalf("AdmitTuttiModeSchedule() error = %v, want ErrWakeRejected", err)
		}
		assertClosedWakeCommandRollback(
			t, store, issue, aggregate.Checkpoints[0].ID,
			string(executionbiz.StatusAwaitingSchedule),
			string(executionbiz.CheckpointStatusActive),
			string(workspaceissues.StatusNotStarted),
			0,
		)
	})

	t.Run("acknowledge", func(t *testing.T) {
		ctx := context.Background()
		store := openTuttiModeExecutionStore(t)
		now := time.UnixMilli(1_700_000_085_000).UTC()
		prepareTuttiModeExecutionWorkspace(
			t, store, "workspace-wake-ack-fence", "workflow-wake-ack-fence",
			"session-wake-ack-fence", now,
		)
		executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
		issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
		issue, tasks := prepareTuttiModeIssueGraph(
			t, issues, "workspace-wake-ack-fence", "workflow-wake-ack-fence",
			"session-wake-ack-fence",
		)
		_, _, aggregate, err := executions.Materialize(ctx, executionservice.MaterializeInput{
			Issue: issue, Tasks: tasks, WorkflowID: "workflow-wake-ack-fence",
		})
		if err != nil {
			t.Fatalf("Materialize() error = %v", err)
		}
		run := tuttiModeScheduleTestRun(issue, tasks[0], "run-wake-ack-fence", now)
		if _, err := store.AdmitTuttiModeSchedule(ctx, executionbiz.ScheduleAdmission{
			WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
			SourceSessionID:       issue.SourceSessionID,
			CheckpointID:          aggregate.Checkpoints[0].ID,
			ExpectedGraphRevision: 1,
			RequestID:             "request-wake-ack-setup",
			InputSHA256:           "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			Runs:                  []workspaceissues.Run{run},
			Now:                   now,
		}); err != nil {
			t.Fatalf("AdmitTuttiModeSchedule(setup) error = %v", err)
		}
		if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_runs
SET status = 'completed', completed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND run_id = ?
`, now.UnixMilli(), now.UnixMilli(), issue.WorkspaceID, run.RunID); err != nil {
			t.Fatalf("settle fixture Run error = %v", err)
		}
		if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_issue_tasks
SET status = 'pending_acceptance', updated_at_unix_ms = ?
WHERE workspace_id = ? AND issue_id = ? AND task_id = ?
`, now.UnixMilli(), issue.WorkspaceID, issue.IssueID, run.TaskID); err != nil {
			t.Fatalf("settle fixture task error = %v", err)
		}
		checkpoint, created, err := store.EnsureTuttiModeRunSettlement(
			ctx,
			executionbiz.RunSettlement{
				WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
				TaskID: run.TaskID, RunID: run.RunID,
				Status: workspaceissues.StatusCompleted, Now: now,
			},
		)
		if err != nil || !created {
			t.Fatalf("EnsureTuttiModeRunSettlement() checkpoint=%#v created=%v error=%v", checkpoint, created, err)
		}
		if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_execution_wakes
SET status = 'canceled'
WHERE workspace_id = ? AND checkpoint_id = ?
`, issue.WorkspaceID, checkpoint.ID); err != nil {
			t.Fatalf("close active checkpoint wake error = %v", err)
		}
		var executionStatus, checkpointStatus, taskStatus string
		var running, later int
		if err := store.writeDB.QueryRowContext(ctx, `
SELECT
  (SELECT status FROM workspace_tutti_executions WHERE workspace_id = ? AND issue_id = ?),
  (SELECT status FROM workspace_tutti_execution_checkpoints WHERE workspace_id = ? AND checkpoint_id = ?),
  (SELECT status FROM workspace_issue_tasks WHERE workspace_id = ? AND issue_id = ? AND task_id = ?),
  (SELECT COUNT(*) FROM workspace_issue_runs WHERE workspace_id = ? AND issue_id = ? AND status = 'running'),
  (SELECT COUNT(*) FROM workspace_tutti_execution_checkpoints
   WHERE workspace_id = ? AND execution_id = ? AND sequence > ? AND status = 'pending')
`, issue.WorkspaceID, issue.IssueID,
			issue.WorkspaceID, checkpoint.ID,
			issue.WorkspaceID, issue.IssueID, run.TaskID,
			issue.WorkspaceID, issue.IssueID,
			issue.WorkspaceID, checkpoint.ExecutionID, checkpoint.Sequence,
		).Scan(&executionStatus, &checkpointStatus, &taskStatus, &running, &later); err != nil {
			t.Fatalf("read acknowledge fixture state error = %v", err)
		}
		if executionStatus != string(executionbiz.StatusAwaitingMain) ||
			checkpointStatus != string(executionbiz.CheckpointStatusActive) ||
			taskStatus != string(workspaceissues.StatusPendingAcceptance) ||
			(running == 0 && later == 0) {
			t.Fatalf(
				"acknowledge fixture execution=%q checkpoint=%q task=%q running/later=%d/%d",
				executionStatus, checkpointStatus, taskStatus, running, later,
			)
		}
		_, err = store.AdmitTuttiModeAcknowledge(ctx, executionbiz.AcknowledgeAdmission{
			WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
			SourceSessionID:       issue.SourceSessionID,
			CheckpointID:          checkpoint.ID,
			ExpectedGraphRevision: 1,
			RequestID:             "request-wake-ack-fence",
			InputSHA256:           "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			Now:                   now,
		})
		if !errors.Is(err, executionbiz.ErrWakeRejected) {
			t.Fatalf("AdmitTuttiModeAcknowledge() error = %v, want ErrWakeRejected", err)
		}
		assertClosedWakeCommandRollback(
			t, store, issue, checkpoint.ID,
			string(executionbiz.StatusAwaitingMain),
			string(executionbiz.CheckpointStatusActive),
			string(workspaceissues.StatusPendingAcceptance),
			1,
		)
	})
}

func tuttiModeScheduleTestRun(
	issue workspaceissues.Issue,
	task workspaceissues.Task,
	runID string,
	now time.Time,
) workspaceissues.Run {
	return workspaceissues.Run{
		RunID: runID, TaskID: task.TaskID, IssueID: issue.IssueID,
		WorkspaceID: issue.WorkspaceID, RequesterUserID: "local",
		AgentUserID: "local", AgentTargetID: task.AgentTargetID,
		AgentSessionID: "delegate-" + runID, AgentProvider: "codex",
		Status: workspaceissues.StatusRunning, CreatedAtUnixMS: now.UnixMilli(),
		StartedAtUnixMS: now.UnixMilli(), UpdatedAtUnixMS: now.UnixMilli(),
	}
}

func assertClosedWakeCommandRollback(
	t *testing.T,
	store *SQLiteStore,
	issue workspaceissues.Issue,
	checkpointID string,
	wantExecutionStatus string,
	wantCheckpointStatus string,
	wantTaskStatus string,
	wantMutationCount int,
) {
	t.Helper()
	var executionStatus, checkpointStatus, taskStatus string
	var graphRevision int64
	var runCount, launchIntentCount, mutationCount int
	if err := store.writeDB.QueryRow(`
SELECT
  (SELECT status FROM workspace_tutti_executions WHERE workspace_id = ? AND issue_id = ?),
  (SELECT graph_revision FROM workspace_tutti_executions WHERE workspace_id = ? AND issue_id = ?),
  (SELECT status FROM workspace_tutti_execution_checkpoints WHERE workspace_id = ? AND checkpoint_id = ?),
  (SELECT status FROM workspace_issue_tasks WHERE workspace_id = ? AND issue_id = ? LIMIT 1),
  (SELECT COUNT(*) FROM workspace_issue_runs WHERE workspace_id = ? AND issue_id = ?),
  (SELECT COUNT(*) FROM workspace_issue_run_launch_intents WHERE workspace_id = ? AND issue_id = ?),
  (SELECT COUNT(*) FROM workspace_tutti_execution_mutations WHERE workspace_id = ? AND issue_id = ?)
`, issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, checkpointID,
		issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, issue.IssueID,
	).Scan(
		&executionStatus, &graphRevision, &checkpointStatus, &taskStatus,
		&runCount, &launchIntentCount, &mutationCount,
	); err != nil {
		t.Fatalf("read closed-wake rollback state error = %v", err)
	}
	if executionStatus != wantExecutionStatus || graphRevision != 1 ||
		checkpointStatus != wantCheckpointStatus || taskStatus != wantTaskStatus ||
		mutationCount != wantMutationCount {
		t.Fatalf(
			"closed-wake rollback execution=%q revision=%d checkpoint=%q task=%q mutations=%d",
			executionStatus, graphRevision, checkpointStatus, taskStatus, mutationCount,
		)
	}
	if wantMutationCount == 0 && (runCount != 0 || launchIntentCount != 0) {
		t.Fatalf(
			"rejected schedule leaked run/intent rows = %d/%d",
			runCount, launchIntentCount,
		)
	}
}

func TestTuttiModeExecutionMaterializationRejectsDuplicateAndPreservesOriginal(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_100_000).UTC()
	prepareTuttiModeExecutionWorkspace(t, store, "workspace-replay", "workflow-replay", "session-replay", now)
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(t, issues, "workspace-replay", "workflow-replay", "session-replay")

	firstIssue, _, firstAggregate, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-replay",
	})
	if err != nil {
		t.Fatalf("Materialize(first) error = %v", err)
	}
	if _, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-replay",
	}); !errors.Is(err, workspaceissues.ErrIssueAlreadyExists) {
		t.Fatalf("Materialize(duplicate) error = %v, want ErrIssueAlreadyExists", err)
	}
	var issueCount, executionCount, checkpointCount int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM workspace_issues WHERE workspace_id = ? AND issue_id = ?),
  (SELECT COUNT(*) FROM workspace_tutti_executions WHERE workspace_id = ? AND issue_id = ?),
  (SELECT COUNT(*) FROM workspace_tutti_execution_checkpoints WHERE workspace_id = ?)
`, issue.WorkspaceID, firstIssue.IssueID, issue.WorkspaceID, firstIssue.IssueID, issue.WorkspaceID).
		Scan(&issueCount, &executionCount, &checkpointCount); err != nil {
		t.Fatalf("count replay rows error = %v", err)
	}
	if issueCount != 1 || executionCount != 1 || checkpointCount != 1 {
		t.Fatalf("replay row counts issue=%d execution=%d checkpoint=%d, want 1/1/1", issueCount, executionCount, checkpointCount)
	}
	persisted, err := executions.GetByIssue(ctx, issue.WorkspaceID, issue.IssueID)
	if err != nil || persisted.Execution.ID != firstAggregate.Execution.ID {
		t.Fatalf("GetByIssue() after duplicate aggregate=%#v error=%v", persisted, err)
	}
}

func TestAdmitTuttiModeScheduleAtomicallyClaimsRunAndLaunchIntent(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_150_000).UTC()
	prepareTuttiModeExecutionWorkspace(
		t, store, "workspace-schedule-admission", "workflow-schedule-admission",
		"session-schedule-admission", now,
	)
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, "workspace-schedule-admission", "workflow-schedule-admission",
		"session-schedule-admission",
	)
	_, _, aggregate, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-schedule-admission",
	})
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	run := workspaceissues.Run{
		RunID:           "run-schedule-admission",
		TaskID:          tasks[0].TaskID,
		IssueID:         issue.IssueID,
		WorkspaceID:     issue.WorkspaceID,
		RequesterUserID: "local",
		AgentUserID:     "local",
		AgentTargetID:   tasks[0].AgentTargetID,
		AgentSessionID:  "delegate-schedule-admission",
		AgentProvider:   "codex",
		Status:          workspaceissues.StatusRunning,
		CreatedAtUnixMS: now.UnixMilli(),
		StartedAtUnixMS: now.UnixMilli(),
		UpdatedAtUnixMS: now.UnixMilli(),
	}
	result, err := store.AdmitTuttiModeSchedule(ctx, executionbiz.ScheduleAdmission{
		WorkspaceID:           issue.WorkspaceID,
		IssueID:               issue.IssueID,
		SourceSessionID:       issue.SourceSessionID,
		CheckpointID:          aggregate.Checkpoints[0].ID,
		ExpectedGraphRevision: 1,
		RequestID:             "request-schedule-admission",
		InputSHA256:           "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Runs:                  []workspaceissues.Run{run},
		Now:                   now,
	})
	if err != nil {
		t.Fatalf("AdmitTuttiModeSchedule() error = %v", err)
	}
	if len(result.RunIDs) != 1 || result.RunIDs[0] != run.RunID {
		t.Fatalf("AdmitTuttiModeSchedule() result = %#v", result)
	}

	var runCount int
	var taskStatus, intentStatus, clientSubmitID, checkpointStatus string
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM workspace_issue_runs WHERE workspace_id = ? AND run_id = ?),
  (SELECT status FROM workspace_issue_tasks WHERE workspace_id = ? AND issue_id = ? AND task_id = ?),
  (SELECT status FROM workspace_issue_run_launch_intents WHERE workspace_id = ? AND run_id = ?),
  (SELECT client_submit_id FROM workspace_issue_run_launch_intents WHERE workspace_id = ? AND run_id = ?),
  (SELECT status FROM workspace_tutti_execution_checkpoints WHERE workspace_id = ? AND checkpoint_id = ?)
`, issue.WorkspaceID, run.RunID,
		issue.WorkspaceID, issue.IssueID, run.TaskID,
		issue.WorkspaceID, run.RunID,
		issue.WorkspaceID, run.RunID,
		issue.WorkspaceID, aggregate.Checkpoints[0].ID,
	).Scan(&runCount, &taskStatus, &intentStatus, &clientSubmitID, &checkpointStatus); err != nil {
		t.Fatalf("read admitted schedule state error = %v", err)
	}
	if runCount != 1 || taskStatus != string(workspaceissues.StatusRunning) ||
		intentStatus != "prepared" || clientSubmitID != "issue-run:"+run.RunID ||
		checkpointStatus != string(executionbiz.CheckpointStatusResolved) {
		t.Fatalf(
			"admitted state runCount=%d task=%q intent=%q submit=%q checkpoint=%q",
			runCount, taskStatus, intentStatus, clientSubmitID, checkpointStatus,
		)
	}
	claimed, err := store.ClaimTuttiModeRunLaunchIntent(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID, "lease-owner",
		now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimTuttiModeRunLaunchIntent() claimed=%v error=%v", claimed, err)
	}
	if err := store.RenewTuttiModeRunLaunchIntent(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID, "lease-owner",
		now.Add(30*time.Second), now.Add(90*time.Second),
	); err != nil {
		t.Fatalf("RenewTuttiModeRunLaunchIntent() error = %v", err)
	}
	if err := store.RequeueLeasedTuttiModeRunLaunchIntents(
		ctx, issue.WorkspaceID, now.Add(70*time.Second),
	); err != nil {
		t.Fatalf("RequeueLeasedTuttiModeRunLaunchIntents(valid) error = %v", err)
	}
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT status FROM workspace_issue_run_launch_intents
WHERE workspace_id = ? AND run_id = ?
`, issue.WorkspaceID, run.RunID).Scan(&intentStatus); err != nil {
		t.Fatalf("read valid renewed intent error = %v", err)
	}
	if intentStatus != "leased" {
		t.Fatalf("valid renewed intent status = %q, want leased", intentStatus)
	}
	if err := store.RequeueLeasedTuttiModeRunLaunchIntents(
		ctx, issue.WorkspaceID, now.Add(100*time.Second),
	); err != nil {
		t.Fatalf("RequeueLeasedTuttiModeRunLaunchIntents(expired) error = %v", err)
	}
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT status FROM workspace_issue_run_launch_intents
WHERE workspace_id = ? AND run_id = ?
`, issue.WorkspaceID, run.RunID).Scan(&intentStatus); err != nil {
		t.Fatalf("read expired intent error = %v", err)
	}
	if intentStatus != "prepared" {
		t.Fatalf("expired intent status = %q, want prepared", intentStatus)
	}
}

func TestFailTuttiModeRunLaunchIsOwnerFencedAndAtomicWithSettlement(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_165_000).UTC()
	prepareTuttiModeExecutionWorkspace(
		t, store, "workspace-launch-failure", "workflow-launch-failure",
		"session-launch-failure", now,
	)
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, "workspace-launch-failure", "workflow-launch-failure",
		"session-launch-failure",
	)
	_, _, aggregate, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-launch-failure",
	})
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	run := workspaceissues.Run{
		RunID: "run-launch-failure", TaskID: tasks[0].TaskID,
		IssueID: issue.IssueID, WorkspaceID: issue.WorkspaceID,
		RequesterUserID: "local", AgentUserID: "local",
		AgentTargetID:  tasks[0].AgentTargetID,
		AgentSessionID: "delegate-launch-failure", AgentProvider: "codex",
		Status:          workspaceissues.StatusRunning,
		CreatedAtUnixMS: now.UnixMilli(), StartedAtUnixMS: now.UnixMilli(),
		UpdatedAtUnixMS: now.UnixMilli(),
	}
	if _, err := store.AdmitTuttiModeSchedule(ctx, executionbiz.ScheduleAdmission{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
		SourceSessionID: issue.SourceSessionID,
		CheckpointID:    aggregate.Checkpoints[0].ID, ExpectedGraphRevision: 1,
		RequestID:   "request-launch-failure",
		InputSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Runs:        []workspaceissues.Run{run}, Now: now,
	}); err != nil {
		t.Fatalf("AdmitTuttiModeSchedule() error = %v", err)
	}
	claimed, err := store.ClaimTuttiModeRunLaunchIntent(
		ctx, issue.WorkspaceID, issue.IssueID, run.RunID, "owner-current",
		now, now.Add(time.Minute),
	)
	if err != nil || !claimed {
		t.Fatalf("ClaimTuttiModeRunLaunchIntent() claimed=%v error=%v", claimed, err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TRIGGER reject_failed_settlement
BEFORE INSERT ON workspace_tutti_execution_checkpoints
WHEN NEW.kind = 'task_failed'
BEGIN
  SELECT RAISE(ABORT, 'injected settlement persistence failure');
END;
`); err != nil {
		t.Fatalf("create settlement failure trigger error = %v", err)
	}
	failure := executionbiz.RunLaunchFailure{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
		RunID: run.RunID, LeaseOwner: "owner-current",
		ErrorMessage: "definite pre-canonical failure", Now: now.Add(time.Second),
	}
	if _, _, err := store.FailTuttiModeRunLaunch(ctx, failure); err == nil {
		t.Fatal("FailTuttiModeRunLaunch() error = nil, want injected rollback")
	}
	assertLaunchFailureState := func(
		wantIntent, wantOwner, wantRun, wantTask string,
		wantCheckpointCount int,
	) {
		t.Helper()
		var intentStatus, leaseOwner, runStatus, taskStatus string
		var checkpointCount int
		if err := store.writeDB.QueryRowContext(ctx, `
SELECT
 (SELECT status FROM workspace_issue_run_launch_intents
   WHERE workspace_id = ? AND run_id = ?),
 (SELECT lease_owner FROM workspace_issue_run_launch_intents
   WHERE workspace_id = ? AND run_id = ?),
 (SELECT status FROM workspace_issue_runs
   WHERE workspace_id = ? AND run_id = ?),
 (SELECT status FROM workspace_issue_tasks
   WHERE workspace_id = ? AND issue_id = ? AND task_id = ?),
 (SELECT COUNT(*) FROM workspace_tutti_execution_checkpoints
   WHERE workspace_id = ? AND execution_id = ?)
`, issue.WorkspaceID, run.RunID,
			issue.WorkspaceID, run.RunID,
			issue.WorkspaceID, run.RunID,
			issue.WorkspaceID, issue.IssueID, run.TaskID,
			issue.WorkspaceID, aggregate.Execution.ID,
		).Scan(&intentStatus, &leaseOwner, &runStatus, &taskStatus, &checkpointCount); err != nil {
			t.Fatalf("read launch failure state error = %v", err)
		}
		if intentStatus != wantIntent || leaseOwner != wantOwner ||
			runStatus != wantRun || taskStatus != wantTask ||
			checkpointCount != wantCheckpointCount {
			t.Fatalf(
				"state intent=%q owner=%q run=%q task=%q checkpoints=%d, want %q/%q/%q/%q/%d",
				intentStatus, leaseOwner, runStatus, taskStatus, checkpointCount,
				wantIntent, wantOwner, wantRun, wantTask, wantCheckpointCount,
			)
		}
	}
	assertLaunchFailureState("leased", "owner-current", "running", "running", 1)
	if _, err := store.writeDB.ExecContext(ctx, `DROP TRIGGER reject_failed_settlement`); err != nil {
		t.Fatalf("drop settlement failure trigger error = %v", err)
	}
	checkpoint, created, err := store.FailTuttiModeRunLaunch(ctx, failure)
	if err != nil || !created || checkpoint.Kind != executionbiz.CheckpointKindTaskFailed {
		t.Fatalf(
			"FailTuttiModeRunLaunch(retry) checkpoint=%#v created=%v error=%v",
			checkpoint, created, err,
		)
	}
	assertLaunchFailureState("failed", "", "failed", "failed", 3)
}

func TestAdmitTuttiModeScheduleRejectsWholeInvalidSet(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_175_000).UTC()
	prepareTuttiModeExecutionWorkspace(
		t, store, "workspace-schedule-reject", "workflow-schedule-reject",
		"session-schedule-reject", now,
	)
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(
		t, issues, "workspace-schedule-reject", "workflow-schedule-reject",
		"session-schedule-reject",
	)
	_, _, aggregate, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-schedule-reject",
	})
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}
	validRun := workspaceissues.Run{
		RunID: "run-valid", TaskID: tasks[0].TaskID, IssueID: issue.IssueID,
		WorkspaceID: issue.WorkspaceID, AgentTargetID: tasks[0].AgentTargetID,
		AgentSessionID: "delegate-valid", Status: workspaceissues.StatusRunning,
		CreatedAtUnixMS: now.UnixMilli(), StartedAtUnixMS: now.UnixMilli(),
		UpdatedAtUnixMS: now.UnixMilli(),
	}
	invalidRun := validRun
	invalidRun.RunID = "run-invalid"
	invalidRun.TaskID = "missing-task"
	_, err = store.AdmitTuttiModeSchedule(ctx, executionbiz.ScheduleAdmission{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.IssueID,
		SourceSessionID: issue.SourceSessionID,
		CheckpointID:    aggregate.Checkpoints[0].ID, ExpectedGraphRevision: 1,
		RequestID:   "request-schedule-reject",
		InputSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Runs:        []workspaceissues.Run{validRun, invalidRun}, Now: now,
	})
	if !errors.Is(err, executionbiz.ErrScheduleRejected) {
		t.Fatalf("AdmitTuttiModeSchedule() error = %v, want ErrScheduleRejected", err)
	}
	var runCount int
	var taskStatus, checkpointStatus string
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT
  (SELECT COUNT(*) FROM workspace_issue_runs WHERE workspace_id = ? AND issue_id = ?),
  (SELECT status FROM workspace_issue_tasks WHERE workspace_id = ? AND issue_id = ? AND task_id = ?),
  (SELECT status FROM workspace_tutti_execution_checkpoints WHERE workspace_id = ? AND checkpoint_id = ?)
`, issue.WorkspaceID, issue.IssueID,
		issue.WorkspaceID, issue.IssueID, tasks[0].TaskID,
		issue.WorkspaceID, aggregate.Checkpoints[0].ID,
	).Scan(&runCount, &taskStatus, &checkpointStatus); err != nil {
		t.Fatalf("read rejected schedule state error = %v", err)
	}
	if runCount != 0 || taskStatus != string(workspaceissues.StatusNotStarted) ||
		checkpointStatus != string(executionbiz.CheckpointStatusActive) {
		t.Fatalf("rejected state runCount=%d task=%q checkpoint=%q", runCount, taskStatus, checkpointStatus)
	}
}

func TestTuttiModeExecutionMaterializationRollsBackIssueOnExecutionFailure(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_200_000).UTC()
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-rollback", Name: "Rollback"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(t, issues, "workspace-rollback", "missing-workflow", "session-rollback")

	_, _, _, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "missing-workflow",
	})
	if err == nil {
		t.Fatal("Materialize() error = nil, want missing workflow foreign-key failure")
	}
	if _, err := store.GetIssue(ctx, issue.WorkspaceID, issue.IssueID); !errors.Is(err, workspaceissues.ErrIssueNotFound) {
		t.Fatalf("GetIssue() after rollback error = %v, want ErrIssueNotFound", err)
	}
	if _, err := executions.GetByIssue(ctx, issue.WorkspaceID, issue.IssueID); !errors.Is(err, executionbiz.ErrExecutionNotFound) {
		t.Fatalf("GetByIssue() after rollback error = %v, want ErrExecutionNotFound", err)
	}
}

func TestGetTuttiModeExecutionByIssueReadsOneConcurrentSnapshot(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTuttiModeExecutionStore(t)
	now := time.UnixMilli(1_700_000_300_000).UTC()
	prepareTuttiModeExecutionWorkspace(t, store, "workspace-snapshot", "workflow-snapshot", "session-snapshot", now)
	executions := &executionservice.Service{Store: store, Clock: func() time.Time { return now }}
	issues := workspaceissues.Service{Store: store, Clock: func() time.Time { return now }}
	issue, tasks := prepareTuttiModeIssueGraph(t, issues, "workspace-snapshot", "workflow-snapshot", "session-snapshot")
	_, _, initial, err := executions.Materialize(ctx, executionservice.MaterializeInput{
		Issue: issue, Tasks: tasks, WorkflowID: "workflow-snapshot",
	})
	if err != nil {
		t.Fatalf("Materialize() error = %v", err)
	}

	nextCheckpointID := initial.Execution.ID + ":checkpoint:task-settled"
	snapshot, err := store.getTuttiModeExecutionByIssueSnapshot(
		ctx,
		issue.WorkspaceID,
		issue.IssueID,
		func() error {
			result := make(chan error, 1)
			go func() {
				tx, beginErr := store.writeDB.BeginTx(ctx, nil)
				if beginErr != nil {
					result <- beginErr
					return
				}
				defer func() { _ = tx.Rollback() }()
				if _, updateErr := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'running', graph_revision = 2, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ?
`, now.Add(time.Second).UnixMilli(), issue.WorkspaceID, initial.Execution.ID); updateErr != nil {
					result <- updateErr
					return
				}
				if _, updateErr := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'resolved', resolved_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND checkpoint_id = ?
`, now.Add(time.Second).UnixMilli(), now.Add(time.Second).UnixMilli(), issue.WorkspaceID, initial.Checkpoints[0].ID); updateErr != nil {
					result <- updateErr
					return
				}
				if insertErr := insertTuttiModeExecutionCheckpoint(ctx, tx, issue.WorkspaceID, executionbiz.Checkpoint{
					ID:             nextCheckpointID,
					ExecutionID:    initial.Execution.ID,
					Kind:           executionbiz.CheckpointKindTaskSettled,
					Status:         executionbiz.CheckpointStatusActive,
					Sequence:       2,
					GraphRevision:  2,
					SubjectTaskID:  "task-1",
					CreationReason: "concurrent transition",
					CreatedAt:      now.Add(time.Second),
					UpdatedAt:      now.Add(time.Second),
				}); insertErr != nil {
					result <- insertErr
					return
				}
				result <- tx.Commit()
			}()
			return <-result
		},
	)
	if err != nil {
		t.Fatalf("getTuttiModeExecutionByIssueSnapshot() error = %v", err)
	}
	if snapshot.Execution.Status != executionbiz.StatusAwaitingSchedule ||
		snapshot.Execution.GraphRevision != 1 ||
		snapshot.Execution.ActiveCheckpointID != initial.Checkpoints[0].ID ||
		len(snapshot.Checkpoints) != 1 ||
		snapshot.Checkpoints[0].Status != executionbiz.CheckpointStatusActive {
		t.Fatalf("concurrent read snapshot = %#v, want complete initial revision", snapshot)
	}

	current, err := executions.GetByIssue(ctx, issue.WorkspaceID, issue.IssueID)
	if err != nil {
		t.Fatalf("GetByIssue(current) error = %v", err)
	}
	if current.Execution.Status != executionbiz.StatusRunning ||
		current.Execution.GraphRevision != 2 ||
		current.Execution.ActiveCheckpointID != nextCheckpointID ||
		len(current.Checkpoints) != 2 ||
		current.Checkpoints[0].Status != executionbiz.CheckpointStatusResolved ||
		current.Checkpoints[1].Status != executionbiz.CheckpointStatusActive {
		t.Fatalf("current aggregate = %#v, want complete second revision", current)
	}
}

func openTuttiModeExecutionStore(t *testing.T) *SQLiteStore {
	t.Helper()
	store, err := OpenSQLiteStore(filepath.Join(t.TempDir(), "tutti.sqlite"))
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}

func prepareTuttiModeExecutionWorkspace(
	t *testing.T,
	store *SQLiteStore,
	workspaceID string,
	workflowID string,
	sourceSessionID string,
	now time.Time,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := store.Get(ctx, workspaceID); errors.Is(err, ErrWorkspaceNotFound) {
		if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: workspaceID}); err != nil {
			t.Fatalf("Create() workspace error = %v", err)
		}
	} else if err != nil {
		t.Fatalf("Get() workspace error = %v", err)
	}
	revisionID := "revision-" + workflowID
	if err := store.CreateWorkspaceWorkflowProposal(ctx, workflowbiz.ProposalAggregate{
		Workflow: workflowbiz.Workflow{
			ID:                workflowID,
			WorkspaceID:       workspaceID,
			Type:              workflowbiz.WorkflowTypeTuttiModePlan,
			Owner:             workflowbiz.WorkflowOwnerTutti,
			TriggerKind:       workflowbiz.TriggerKindAgentCLI,
			SourceSessionID:   sourceSessionID,
			Status:            workflowbiz.WorkflowStatusPendingReview,
			CurrentRevisionID: revisionID,
			CreatedAt:         now,
			UpdatedAt:         now,
		},
		Plan: workflowbiz.TuttiModePlan{WorkflowID: workflowID},
		Revision: workflowbiz.PlanRevision{
			ID:            revisionID,
			WorkflowID:    workflowID,
			Sequence:      1,
			SchemaVersion: "tutti-mode-plan/v1",
			DocumentPath:  "plans/" + revisionID + ".md",
			SHA256:        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			CreatedAt:     now,
		},
		Checkpoint: workflowbiz.WorkflowCheckpoint{
			ID:         "review-" + workflowID,
			WorkflowID: workflowID,
			Kind:       workflowbiz.CheckpointKindTaskReview,
			RevisionID: revisionID,
			Status:     workflowbiz.CheckpointStatusPending,
			CreatedAt:  now,
			UpdatedAt:  now,
		},
	}); err != nil {
		t.Fatalf("CreateWorkspaceWorkflowProposal() error = %v", err)
	}
}

func prepareTuttiModeIssueGraph(
	t *testing.T,
	issues workspaceissues.Service,
	workspaceID string,
	workflowID string,
	sourceSessionID string,
) (workspaceissues.Issue, []workspaceissues.Task) {
	t.Helper()
	issueID, ok := workflowbiz.TuttiModePlanIssueID(workflowID)
	if !ok {
		t.Fatal("TuttiModePlanIssueID() rejected fixture")
	}
	issue, tasks, err := issues.PrepareIssueWithTasks(context.Background(), workspaceissues.CreateIssueWithTasksInput{
		Issue: workspaceissues.CreateIssueInput{
			IssueID:             issueID,
			TopicID:             workspaceissues.DefaultTopicID,
			WorkspaceID:         workspaceID,
			ActorUserID:         "local",
			Title:               "Materialized execution",
			Content:             "Accepted plan",
			PlanningSource:      string(workspaceissues.PlanningSourceTuttiModePlan),
			SourceSessionID:     sourceSessionID,
			SequentialExecution: true,
			HasBudget:           true,
			Budget:              workspaceissues.Budget{Mode: workspaceissues.BudgetModeAuto},
		},
		Tasks: []workspaceissues.CreateTaskItemInput{{
			TaskID: "task-1", Title: "Implement", AgentTargetID: "local:codex",
		}},
	})
	if err != nil {
		t.Fatalf("PrepareIssueWithTasks() error = %v", err)
	}
	return issue, tasks
}

func sqliteTableHasColumn(t *testing.T, store *SQLiteStore, table, column string) bool {
	t.Helper()
	rows, err := store.writeDB.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("PRAGMA table_info(%q) error = %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan table info %q error = %v", table, err)
		}
		if name == column {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate table info %q error = %v", table, err)
	}
	return false
}

func dropTuttiModeExecutionMigrationForUpgradeTest(ctx context.Context, store *SQLiteStore) error {
	_, err := store.writeDB.ExecContext(ctx, `
DROP TABLE workspace_issue_run_cancel_compensations;
DROP TABLE workspace_issue_run_launch_intents;
DROP TABLE workspace_source_session_deletion_admissions;
DROP TABLE workspace_tutti_execution_mutations;
DROP TABLE workspace_tutti_archive_operations;
DROP TABLE workspace_tutti_source_activity_inbox;
DROP TABLE workspace_tutti_goal_reviews;
DROP TABLE workspace_tutti_execution_wakes;
DROP TABLE workspace_tutti_execution_checkpoints;
DROP TABLE workspace_tutti_executions;
DELETE FROM tuttid_schema_migrations WHERE id IN (?, ?, ?);
`, schemaMigrationWorkspaceTuttiModeExecutionV1,
		schemaMigrationWorkspaceTuttiModeRunCancelCompensationV2,
		schemaMigrationWorkspaceTuttiModeSourceActivityInboxV3)
	return err
}
