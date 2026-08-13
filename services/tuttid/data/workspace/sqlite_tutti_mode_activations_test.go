package workspace

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteStoreTuttiModeActivationRevisionLifecycle(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-activation", Name: "Activation"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()

	activation, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-activation", AgentSessionID: "session-1",
		ActivationID: "activation-1", RevisionID: "revision-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now,
	})
	if err != nil || !changed || activation.CurrentRevision.Revision != 1 {
		t.Fatalf("first SetTuttiModeActivation() activation=%#v changed=%v err=%v", activation, changed, err)
	}

	retry, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-activation", AgentSessionID: "session-1",
		ActivationID: "unused-on-retry", RevisionID: "unused-on-retry",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now.Add(time.Second),
	})
	if err != nil || changed || retry.CurrentRevision.ID != "revision-1" {
		t.Fatalf("idempotent SetTuttiModeActivation() activation=%#v changed=%v err=%v", retry, changed, err)
	}
	missing := int64(0)
	_, _, err = store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-activation", AgentSessionID: "session-1",
		RevisionID: "revision-idempotent-stale", ExpectedRevision: &missing,
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now.Add(time.Second),
	})
	if !errors.Is(err, ErrTuttiModeActivationRevisionConflict) {
		t.Fatalf("idempotent stale SetTuttiModeActivation() error = %v", err)
	}

	expected := int64(1)
	inactive, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-activation", AgentSessionID: "session-1",
		RevisionID: "revision-2", ExpectedRevision: &expected,
		State: activationbiz.StateInactive, Source: activationbiz.SourceBadgeRemove, ChangedAt: now.Add(2 * time.Second),
	})
	if err != nil || !changed || inactive.CurrentRevision.Revision != 2 || inactive.CurrentRevision.State != activationbiz.StateInactive {
		t.Fatalf("deactivate activation=%#v changed=%v err=%v", inactive, changed, err)
	}

	stale := int64(1)
	_, _, err = store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-activation", AgentSessionID: "session-1",
		RevisionID: "revision-stale", ExpectedRevision: &stale,
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now.Add(3 * time.Second),
	})
	if !errors.Is(err, ErrTuttiModeActivationRevisionConflict) {
		t.Fatalf("stale SetTuttiModeActivation() error = %v", err)
	}
}

func TestSQLiteStoreTuttiModeActivationClampsRegressedRevisionTime(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-activation-clock", Name: "Activation Clock"}); err != nil {
		t.Fatal(err)
	}
	createdAt := time.UnixMilli(1_700_000_000_000).UTC()
	first, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-activation-clock", AgentSessionID: "session-1",
		ActivationID: "activation-clock", RevisionID: "revision-clock-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: createdAt,
	})
	if err != nil || !changed {
		t.Fatalf("first activation=%#v changed=%v error=%v", first, changed, err)
	}
	expectedRevision := int64(1)
	second, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-activation-clock", AgentSessionID: "session-1",
		RevisionID: "revision-clock-2", ExpectedRevision: &expectedRevision,
		State: activationbiz.StateInactive, Source: activationbiz.SourceBadgeRemove,
		ChangedAt: createdAt.Add(-time.Hour),
	})
	if err != nil || !changed {
		t.Fatalf("regressed activation=%#v changed=%v error=%v", second, changed, err)
	}
	if second.UpdatedAt.Before(first.UpdatedAt) || second.CurrentRevision.CreatedAt.Before(first.UpdatedAt) {
		t.Fatalf("regressed timestamps first=%s revision=%s updated=%s", first.UpdatedAt, second.CurrentRevision.CreatedAt, second.UpdatedAt)
	}
	stored, ok, err := store.GetTuttiModeActivation(ctx, "ws-activation-clock", "session-1")
	if err != nil || !ok || stored.CurrentRevision.ID != "revision-clock-2" || stored.UpdatedAt.Before(stored.CreatedAt) {
		t.Fatalf("stored activation=%#v ok=%v error=%v", stored, ok, err)
	}
}

func TestSQLiteStoreTuttiModeTurnSnapshotIsImmutableForGuidance(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-turn-snapshot", Name: "Snapshot"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	active := activationbiz.TurnSnapshot{
		ActivationID: "activation-1", RevisionID: "revision-1", Revision: 1,
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
	}
	stored, changed, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-turn-snapshot", "session-1", "turn-1", active, now)
	if err != nil || !changed || stored != active {
		t.Fatalf("PutTuttiModeTurnSnapshot()=%#v changed=%v err=%v", stored, changed, err)
	}
	inactive := activationbiz.TurnSnapshot{
		ActivationID: "activation-1", RevisionID: "revision-2", Revision: 2,
		State: activationbiz.StateInactive, Source: activationbiz.SourceBadgeRemove,
	}
	stored, changed, err = store.PutTuttiModeTurnSnapshot(ctx, "ws-turn-snapshot", "session-1", "turn-1", inactive, now.Add(time.Second))
	if err != nil || changed || stored != active {
		t.Fatalf("immutable retry=%#v changed=%v err=%v, want original", stored, changed, err)
	}
}

func TestSQLiteStoreTuttiModeTurnSnapshotPreparedLifecycle(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-turn-dispatch", Name: "Dispatch"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	snapshot := activationbiz.TurnSnapshot{State: activationbiz.StateInactive}
	if _, changed, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-turn-dispatch", "session-1", "turn-1", snapshot, now); err != nil || !changed {
		t.Fatalf("PutTuttiModeTurnSnapshot() changed=%v err=%v", changed, err)
	}
	if accepted, err := store.IsTuttiModeTurnSnapshotAccepted(ctx, "ws-turn-dispatch", "session-1", "turn-1"); err != nil || accepted {
		t.Fatalf("prepared snapshot accepted=%v err=%v", accepted, err)
	}
	if accepted, err := store.AcceptTuttiModeTurnSnapshot(ctx, "ws-turn-dispatch", "session-1", "turn-1", now.Add(time.Second)); err != nil || !accepted {
		t.Fatalf("AcceptTuttiModeTurnSnapshot() accepted=%v err=%v", accepted, err)
	}
	if accepted, err := store.IsTuttiModeTurnSnapshotAccepted(ctx, "ws-turn-dispatch", "session-1", "turn-1"); err != nil || !accepted {
		t.Fatalf("accepted snapshot accepted=%v err=%v", accepted, err)
	}
	if abandoned, err := store.AbandonTuttiModeTurnSnapshot(ctx, "ws-turn-dispatch", "session-1", "turn-1", snapshot); err != nil || abandoned {
		t.Fatalf("accepted snapshot abandoned=%v err=%v", abandoned, err)
	}
	if _, changed, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-turn-dispatch", "session-1", "turn-2", snapshot, now); err != nil || !changed {
		t.Fatalf("prepare turn-2 changed=%v err=%v", changed, err)
	}
	if abandoned, err := store.AbandonTuttiModeTurnSnapshot(ctx, "ws-turn-dispatch", "session-1", "turn-2", snapshot); err != nil || !abandoned {
		t.Fatalf("prepared snapshot abandoned=%v err=%v", abandoned, err)
	}
	if _, ok, err := store.GetTuttiModeTurnSnapshot(ctx, "ws-turn-dispatch", "session-1", "turn-2"); err != nil || ok {
		t.Fatalf("abandoned snapshot ok=%v err=%v", ok, err)
	}
}

func TestSQLiteStoreTuttiModeTurnSnapshotConcurrentFirstWriteWins(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-turn-race", Name: "Race"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	values := []activationbiz.TurnSnapshot{
		{ActivationID: "activation-1", RevisionID: "revision-1", Revision: 1, State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand},
		{ActivationID: "activation-1", RevisionID: "revision-2", Revision: 2, State: activationbiz.StateInactive, Source: activationbiz.SourceBadgeRemove},
	}
	type result struct {
		snapshot activationbiz.TurnSnapshot
		changed  bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan result, len(values))
	var wg sync.WaitGroup
	for _, value := range values {
		value := value
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			stored, changed, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-turn-race", "session-1", "turn-1", value, now)
			results <- result{snapshot: stored, changed: changed, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	changedCount := 0
	var winner activationbiz.TurnSnapshot
	for result := range results {
		if result.err != nil {
			t.Fatalf("PutTuttiModeTurnSnapshot() error = %v", result.err)
		}
		if result.changed {
			changedCount++
			winner = result.snapshot
		}
	}
	stored, ok, err := store.GetTuttiModeTurnSnapshot(ctx, "ws-turn-race", "session-1", "turn-1")
	if err != nil || !ok || changedCount != 1 || stored != winner {
		t.Fatalf("stored=%#v ok=%v changed=%d winner=%#v err=%v", stored, ok, changedCount, winner, err)
	}
}

func TestSQLiteStoreTuttiModeActivationListAndSessionCleanup(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-activation-list", Name: "List"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	for index, sessionID := range []string{"session-1", "session-2"} {
		_, _, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
			WorkspaceID: "ws-activation-list", AgentSessionID: sessionID,
			ActivationID: "activation-" + sessionID, RevisionID: "revision-" + sessionID,
			State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now.Add(time.Duration(index) * time.Second),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	listed, err := store.ListTuttiModeActivations(ctx, "ws-activation-list", []string{"session-1", "session-2", "session-1", "missing"})
	if err != nil || len(listed) != 2 {
		t.Fatalf("ListTuttiModeActivations()=%#v err=%v", listed, err)
	}
	listedSessionOne := listed["session-1"]
	if _, _, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-activation-list", "session-1", "turn-1", activationbiz.SnapshotFromActivation(&listedSessionOne), now); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteTuttiModeActivationSessionState(ctx, "ws-activation-list", "session-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.GetTuttiModeActivation(ctx, "ws-activation-list", "session-1"); err != nil || ok {
		t.Fatalf("activation after cleanup ok=%v err=%v", ok, err)
	}
	if _, ok, err := store.GetTuttiModeTurnSnapshot(ctx, "ws-activation-list", "session-1", "turn-1"); err != nil || ok {
		t.Fatalf("snapshot after cleanup ok=%v err=%v", ok, err)
	}
}

func TestSQLiteStoreTuttiModeMigrationDoesNotBackfillTurnCapabilityRefs(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-no-backfill", Name: "No Backfill"}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.writeDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM tutti_mode_activations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("activation count = %d, want 0", count)
	}
}

func TestSQLiteStoreTuttiModeTurnDispatchMigrationResumesPartialUpgrade(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)

	// Simulate a process exit after the first v2 ALTER committed but before the
	// second column and migration marker were durable.
	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations WHERE id = ?;
ALTER TABLE tutti_mode_turn_snapshots DROP COLUMN accepted_at_unix_ms;
`, schemaMigrationTuttiModeTurnDispatchV2); err != nil {
		t.Fatalf("simulate partial Tutti mode dispatch migration: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() partial Tutti mode dispatch upgrade error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() repeated Tutti mode dispatch upgrade error = %v", err)
	}
	for _, column := range []string{"dispatch_state", "accepted_at_unix_ms"} {
		hasColumn, err := store.hasColumn(ctx, "tutti_mode_turn_snapshots", column)
		if err != nil || !hasColumn {
			t.Fatalf("column %q present=%v error=%v", column, hasColumn, err)
		}
	}
	applied, err := store.hasMigration(ctx, schemaMigrationTuttiModeTurnDispatchV2)
	if err != nil || !applied {
		t.Fatalf("migration marker present=%v error=%v", applied, err)
	}
}

func TestSQLiteStoreTuttiModeActivationPreferenceRevisions(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-intensity", Name: "Intensity"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()

	// First activation without explicit preferences adopts both defaults.
	first, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-intensity", AgentSessionID: "session-1",
		ActivationID: "activation-1", RevisionID: "revision-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now,
	})
	if err != nil || !changed || first.CurrentRevision.Effect != activationbiz.DefaultEffect || first.CurrentRevision.Speed != activationbiz.DefaultSpeed {
		t.Fatalf("first SetTuttiModeActivation() activation=%#v changed=%v err=%v", first, changed, err)
	}

	// An effect-only change appends a new revision and preserves speed.
	eighty := 80
	second, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-intensity", AgentSessionID: "session-1",
		ActivationID: "unused", RevisionID: "revision-2",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		Effect: &eighty, ChangedAt: now.Add(time.Second),
	})
	if err != nil || !changed || second.CurrentRevision.Revision != 2 || second.CurrentRevision.Effect != 80 || second.CurrentRevision.Speed != 50 {
		t.Fatalf("effect SetTuttiModeActivation() activation=%#v changed=%v err=%v", second, changed, err)
	}

	// The same effect again is an idempotent no-op.
	repeat, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-intensity", AgentSessionID: "session-1",
		ActivationID: "unused", RevisionID: "revision-3",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		Effect: &eighty, ChangedAt: now.Add(2 * time.Second),
	})
	if err != nil || changed || repeat.CurrentRevision.Revision != 2 {
		t.Fatalf("repeat SetTuttiModeActivation() activation=%#v changed=%v err=%v", repeat, changed, err)
	}

	// Speed changes independently while effect is retained.
	ninety := 90
	faster, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-intensity", AgentSessionID: "session-1",
		ActivationID: "unused", RevisionID: "revision-4",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		Speed: &ninety, ChangedAt: now.Add(3 * time.Second),
	})
	if err != nil || !changed || faster.CurrentRevision.Effect != 80 || faster.CurrentRevision.Speed != 90 {
		t.Fatalf("speed SetTuttiModeActivation() activation=%#v changed=%v err=%v", faster, changed, err)
	}

	// Omitting both preferences keeps their values across a state flip.
	inactive, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-intensity", AgentSessionID: "session-1",
		ActivationID: "unused", RevisionID: "revision-5",
		State: activationbiz.StateInactive, Source: activationbiz.SourceBadgeRemove, ChangedAt: now.Add(4 * time.Second),
	})
	if err != nil || !changed || inactive.CurrentRevision.Effect != 80 || inactive.CurrentRevision.Speed != 90 {
		t.Fatalf("inactive SetTuttiModeActivation() activation=%#v changed=%v err=%v", inactive, changed, err)
	}

	// The bound turn snapshot carries both exact revision preferences.
	snapshot, created, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-intensity", "session-1", "turn-1", activationbiz.TurnSnapshot{
		ActivationID: "activation-1", RevisionID: "revision-4", Revision: 3,
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		Effect: 80, Speed: 90,
	}, now.Add(5*time.Second))
	if err != nil || !created || snapshot.Effect != 80 || snapshot.Speed != 90 {
		t.Fatalf("PutTuttiModeTurnSnapshot() snapshot=%#v created=%v err=%v", snapshot, created, err)
	}
	read, found, err := store.GetTuttiModeTurnSnapshot(ctx, "ws-intensity", "session-1", "turn-1")
	if err != nil || !found || read.Effect != 80 || read.Speed != 90 {
		t.Fatalf("GetTuttiModeTurnSnapshot() snapshot=%#v found=%v err=%v", read, found, err)
	}

	// Out-of-range values fail closed.
	invalid := 101
	if _, _, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-intensity", AgentSessionID: "session-1",
		ActivationID: "unused", RevisionID: "revision-6",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		Speed: &invalid, ChangedAt: now.Add(6 * time.Second),
	}); err == nil {
		t.Fatal("SetTuttiModeActivation(101) error = nil, want validation failure")
	}
}

func TestSQLiteStoreTuttiModeActivationLegacyAgentCommandCompatibility(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-agent-command", Name: "Agent Command"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()

	// The persistence adapter still round-trips a historical active revision.
	activated, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-agent-command", AgentSessionID: "session-1",
		ActivationID: "activation-1", RevisionID: "revision-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceAgentCommand, ChangedAt: now,
	})
	if err != nil || !changed || activated.CurrentRevision.State != activationbiz.StateActive ||
		activated.CurrentRevision.Source != activationbiz.SourceAgentCommand {
		t.Fatalf("agent_command activate activation=%#v changed=%v err=%v", activated, changed, err)
	}

	// Historical inactive revisions remain readable as well.
	expected := int64(1)
	deactivated, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-agent-command", AgentSessionID: "session-1",
		RevisionID: "revision-2", ExpectedRevision: &expected,
		State: activationbiz.StateInactive, Source: activationbiz.SourceAgentCommand, ChangedAt: now.Add(time.Second),
	})
	if err != nil || !changed || deactivated.CurrentRevision.State != activationbiz.StateInactive ||
		deactivated.CurrentRevision.Source != activationbiz.SourceAgentCommand {
		t.Fatalf("agent_command deactivate activation=%#v changed=%v err=%v", deactivated, changed, err)
	}

	// Turn snapshots retain both historical state/source pairs.
	inactiveSnapshot := activationbiz.TurnSnapshot{
		ActivationID: "activation-1", RevisionID: "revision-2", Revision: 2,
		State: activationbiz.StateInactive, Source: activationbiz.SourceAgentCommand,
	}
	stored, created, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-agent-command", "session-1", "turn-1", inactiveSnapshot, now.Add(2*time.Second))
	if err != nil || !created || stored != inactiveSnapshot {
		t.Fatalf("inactive agent_command PutTuttiModeTurnSnapshot()=%#v created=%v err=%v", stored, created, err)
	}
	activeSnapshot := activationbiz.TurnSnapshot{
		ActivationID: "activation-1", RevisionID: "revision-1", Revision: 1,
		State: activationbiz.StateActive, Source: activationbiz.SourceAgentCommand,
	}
	stored, created, err = store.PutTuttiModeTurnSnapshot(ctx, "ws-agent-command", "session-1", "turn-2", activeSnapshot, now.Add(3*time.Second))
	if err != nil || !created || stored != activeSnapshot {
		t.Fatalf("active agent_command PutTuttiModeTurnSnapshot()=%#v created=%v err=%v", stored, created, err)
	}

	// The relaxed CHECKs keep the human sources single-direction.
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO tutti_mode_activation_revisions (
  workspace_id, activation_id, revision_id, revision, state, source, created_at_unix_ms
) VALUES ('ws-agent-command', 'activation-1', 'revision-bad', 3, 'active', 'badge_remove', 1)
`); err == nil || !strings.Contains(err.Error(), "CHECK constraint failed") {
		t.Fatalf("active badge_remove revision error = %v, want CHECK constraint failure", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO tutti_mode_turn_snapshots (
  workspace_id, agent_session_id, turn_id, activation_id, revision_id, revision, state, source, created_at_unix_ms
) VALUES ('ws-agent-command', 'session-1', 'turn-bad', 'activation-1', 'revision-1', 1, 'active', 'badge_remove', 1)
`); err == nil || !strings.Contains(err.Error(), "CHECK constraint failed") {
		t.Fatalf("active badge_remove snapshot error = %v, want CHECK constraint failure", err)
	}
}

func TestSQLiteStoreTuttiModeAgentCommandSourceMigrationUpgradesLegacySchema(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-agent-command-upgrade", Name: "Upgrade"}); err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_700_000_000_000).UTC()
	if _, _, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-agent-command-upgrade", AgentSessionID: "session-1",
		ActivationID: "activation-1", RevisionID: "revision-1",
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand, ChangedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	configured := activationbiz.TurnSnapshot{
		ActivationID: "activation-1", RevisionID: "revision-1", Revision: 1,
		State: activationbiz.StateActive, Source: activationbiz.SourceSlashCommand,
		Effect: activationbiz.DefaultEffect, Speed: activationbiz.DefaultSpeed,
	}
	if _, _, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-agent-command-upgrade", "session-1", "turn-1", configured, now); err != nil {
		t.Fatal(err)
	}
	if accepted, err := store.AcceptTuttiModeTurnSnapshot(ctx, "ws-agent-command-upgrade", "session-1", "turn-1", now.Add(time.Second)); err != nil || !accepted {
		t.Fatalf("accept snapshot accepted=%v err=%v", accepted, err)
	}
	if _, _, err := store.PutTuttiModeTurnSnapshot(ctx, "ws-agent-command-upgrade", "session-1", "turn-2",
		activationbiz.TurnSnapshot{State: activationbiz.StateInactive}, now); err != nil {
		t.Fatal(err)
	}

	// Downgrade both tables to the pre-v5 shape: the v1 CHECK vocabulary plus
	// the columns appended by v2-v4, simulating an installed database that ran
	// v1..v4 before this release.
	if _, err := store.writeDB.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		t.Fatalf("disable foreign keys: %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE tutti_mode_activation_revisions_legacy (
  workspace_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
  source TEXT NOT NULL CHECK (source IN ('slash_command', 'badge_remove')),
  created_at_unix_ms INTEGER NOT NULL,
  orchestration_intensity INTEGER NOT NULL DEFAULT 50 CHECK (orchestration_intensity BETWEEN 0 AND 100),
  speed INTEGER NOT NULL DEFAULT 50 CHECK (speed BETWEEN 0 AND 100),
  PRIMARY KEY (workspace_id, activation_id, revision_id),
  UNIQUE (workspace_id, activation_id, revision),
  FOREIGN KEY (workspace_id, activation_id)
    REFERENCES tutti_mode_activations(workspace_id, activation_id) ON DELETE CASCADE,
  CHECK ((state = 'active' AND source = 'slash_command') OR
         (state = 'inactive' AND source = 'badge_remove'))
);
INSERT INTO tutti_mode_activation_revisions_legacy SELECT * FROM tutti_mode_activation_revisions;
DROP TABLE tutti_mode_activation_revisions;
ALTER TABLE tutti_mode_activation_revisions_legacy RENAME TO tutti_mode_activation_revisions;

CREATE TABLE tutti_mode_turn_snapshots_legacy (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  activation_id TEXT NOT NULL DEFAULT '',
  revision_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
  source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'slash_command', 'badge_remove')),
  created_at_unix_ms INTEGER NOT NULL,
  dispatch_state TEXT NOT NULL DEFAULT 'accepted' CHECK (dispatch_state IN ('prepared', 'accepted')),
  accepted_at_unix_ms INTEGER,
  orchestration_intensity INTEGER NOT NULL DEFAULT 0 CHECK (orchestration_intensity BETWEEN 0 AND 100),
  speed INTEGER NOT NULL DEFAULT 0 CHECK (speed BETWEEN 0 AND 100),
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CHECK ((activation_id = '' AND revision_id = '' AND revision = 0 AND state = 'inactive' AND source = '') OR
         (activation_id != '' AND revision_id != '' AND revision > 0 AND
          ((state = 'active' AND source = 'slash_command') OR
           (state = 'inactive' AND source = 'badge_remove'))))
);
INSERT INTO tutti_mode_turn_snapshots_legacy SELECT * FROM tutti_mode_turn_snapshots;
DROP TABLE tutti_mode_turn_snapshots;
ALTER TABLE tutti_mode_turn_snapshots_legacy RENAME TO tutti_mode_turn_snapshots;
CREATE INDEX idx_tutti_mode_turn_snapshots_revision
  ON tutti_mode_turn_snapshots(workspace_id, activation_id, revision);

DELETE FROM tuttid_schema_migrations WHERE id = ?;
`, schemaMigrationTuttiModeAgentCommandSourceV5); err != nil {
		t.Fatalf("install legacy pre-v5 Tutti mode schema: %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("restore foreign keys: %v", err)
	}

	// The legacy vocabulary rejects agent_command, proving the downgrade held.
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO tutti_mode_activation_revisions (
  workspace_id, activation_id, revision_id, revision, state, source, created_at_unix_ms
) VALUES ('ws-agent-command-upgrade', 'activation-1', 'revision-agent', 2, 'inactive', 'agent_command', 1)
`); err == nil || !strings.Contains(err.Error(), "CHECK constraint failed") {
		t.Fatalf("legacy agent_command insert error = %v, want CHECK constraint failure", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() legacy Tutti mode schema error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() repeated after v5 error = %v", err)
	}

	// All pre-upgrade rows survived the rebuild.
	preserved, ok, err := store.GetTuttiModeActivation(ctx, "ws-agent-command-upgrade", "session-1")
	if err != nil || !ok || preserved.CurrentRevision.ID != "revision-1" ||
		preserved.CurrentRevision.Source != activationbiz.SourceSlashCommand ||
		preserved.CurrentRevision.Effect != activationbiz.DefaultEffect ||
		preserved.CurrentRevision.Speed != activationbiz.DefaultSpeed {
		t.Fatalf("preserved activation=%#v ok=%v err=%v", preserved, ok, err)
	}
	snapshot, ok, err := store.GetTuttiModeTurnSnapshot(ctx, "ws-agent-command-upgrade", "session-1", "turn-1")
	if err != nil || !ok || snapshot != configured {
		t.Fatalf("preserved snapshot=%#v ok=%v err=%v", snapshot, ok, err)
	}
	if accepted, err := store.IsTuttiModeTurnSnapshotAccepted(ctx, "ws-agent-command-upgrade", "session-1", "turn-1"); err != nil || !accepted {
		t.Fatalf("preserved dispatch state accepted=%v err=%v", accepted, err)
	}
	unconfigured, ok, err := store.GetTuttiModeTurnSnapshot(ctx, "ws-agent-command-upgrade", "session-1", "turn-2")
	if err != nil || !ok || unconfigured.State != activationbiz.StateInactive || unconfigured.ActivationID != "" {
		t.Fatalf("preserved unconfigured snapshot=%#v ok=%v err=%v", unconfigured, ok, err)
	}

	// The rebuilt schema admits the historical vocabulary so old records remain
	// round-trippable below the product service boundary.
	expected := int64(1)
	deactivated, changed, err := store.SetTuttiModeActivation(ctx, SetTuttiModeActivationInput{
		WorkspaceID: "ws-agent-command-upgrade", AgentSessionID: "session-1",
		RevisionID: "revision-2", ExpectedRevision: &expected,
		State: activationbiz.StateInactive, Source: activationbiz.SourceAgentCommand, ChangedAt: now.Add(2 * time.Second),
	})
	if err != nil || !changed || deactivated.CurrentRevision.Source != activationbiz.SourceAgentCommand {
		t.Fatalf("agent_command after upgrade activation=%#v changed=%v err=%v", deactivated, changed, err)
	}

	foreignKeyRows, err := store.writeDB.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		t.Fatalf("foreign_key_check error = %v", err)
	}
	violation := foreignKeyRows.Next()
	if err := foreignKeyRows.Err(); err != nil {
		_ = foreignKeyRows.Close()
		t.Fatalf("iterate foreign_key_check error = %v", err)
	}
	_ = foreignKeyRows.Close()
	if violation {
		t.Fatal("agent command source migration left a foreign key violation")
	}

	// A fresh install (v1 then v5) and this upgraded database converge on
	// identical effective schemas.
	fresh := openTestSQLiteStore(t)
	for _, objectName := range []string{
		"tutti_mode_activation_revisions",
		"tutti_mode_turn_snapshots",
		"idx_tutti_mode_turn_snapshots_revision",
	} {
		upgradedSQL := tuttiModeSchemaSQL(t, store, objectName)
		freshSQL := tuttiModeSchemaSQL(t, fresh, objectName)
		if upgradedSQL != freshSQL {
			t.Fatalf("schema for %s diverged:\nupgraded: %s\nfresh: %s", objectName, upgradedSQL, freshSQL)
		}
		if objectName != "idx_tutti_mode_turn_snapshots_revision" && !strings.Contains(upgradedSQL, "agent_command") {
			t.Fatalf("schema for %s does not admit agent_command: %s", objectName, upgradedSQL)
		}
	}
}

func tuttiModeSchemaSQL(t *testing.T, store *SQLiteStore, objectName string) string {
	t.Helper()
	var text string
	if err := store.writeDB.QueryRowContext(context.Background(), `
SELECT sql FROM sqlite_master WHERE name = ?
`, objectName).Scan(&text); err != nil {
		t.Fatalf("read sqlite_master sql for %s: %v", objectName, err)
	}
	return text
}
