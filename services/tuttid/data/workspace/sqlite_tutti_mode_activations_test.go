package workspace

import (
	"context"
	"errors"
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
