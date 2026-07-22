package workspace

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"

	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
)

func seedModelPolicyWorkspace(t *testing.T, store *SQLiteStore, workspaceID string) {
	t.Helper()
	now := int64(1700000000000)
	if _, err := store.writeDB.ExecContext(context.Background(), `
INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms)
VALUES (?, 'Model Policy WS', ?, ?);
`, workspaceID, now, now); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
}

func getAcceptanceState(t *testing.T, store *SQLiteStore, workspaceID, sessionID string) modelpolicybiz.AcceptanceState {
	t.Helper()
	acceptance, err := store.GetAgentSessionAcceptance(context.Background(), workspaceID, sessionID)
	if err != nil {
		t.Fatalf("GetAgentSessionAcceptance() error = %v", err)
	}
	return acceptance.State
}

func putAcceptance(t *testing.T, store *SQLiteStore, workspaceID, sessionID string, state modelpolicybiz.AcceptanceState, runID string) {
	t.Helper()
	if err := store.PutAgentSessionAcceptance(context.Background(), modelpolicybiz.Acceptance{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		State:          state,
		ReviewRunID:    runID,
	}); err != nil {
		t.Fatalf("PutAgentSessionAcceptance(%s) error = %v", state, err)
	}
}

func TestAgentSessionAcceptanceLadderUpgradesThenSticks(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedModelPolicyWorkspace(t, store, "ws")

	// The ladder still advances normally before user acceptance.
	putAcceptance(t, store, "ws", "session-1", modelpolicybiz.AcceptanceAgentClaimed, "")
	if got := getAcceptanceState(t, store, "ws", "session-1"); got != modelpolicybiz.AcceptanceAgentClaimed {
		t.Fatalf("state = %q, want agent_claimed", got)
	}
	putAcceptance(t, store, "ws", "session-1", modelpolicybiz.AcceptanceAutoChecked, "run-1")
	if got := getAcceptanceState(t, store, "ws", "session-1"); got != modelpolicybiz.AcceptanceAutoChecked {
		t.Fatalf("state = %q, want auto_checked", got)
	}

	// User accepts.
	putAcceptance(t, store, "ws", "session-1", modelpolicybiz.AcceptanceUserAccepted, "")

	// Later automation writes must not downgrade the terminal user_accepted rung.
	putAcceptance(t, store, "ws", "session-1", modelpolicybiz.AcceptanceAgentClaimed, "")
	putAcceptance(t, store, "ws", "session-1", modelpolicybiz.AcceptanceAutoChecked, "run-2")
	if got := getAcceptanceState(t, store, "ws", "session-1"); got != modelpolicybiz.AcceptanceUserAccepted {
		t.Fatalf("state = %q after later automation writes, want sticky user_accepted", got)
	}

	// The preserved review run id from before acceptance is untouched too.
	acceptance, err := store.GetAgentSessionAcceptance(ctx, "ws", "session-1")
	if err != nil {
		t.Fatalf("GetAgentSessionAcceptance() error = %v", err)
	}
	if acceptance.ReviewRunID != "" {
		t.Fatalf("review run id = %q, want the user_accepted write's empty value preserved", acceptance.ReviewRunID)
	}
}

func TestAgentSessionAcceptanceUserAcceptedStickyUnderConcurrency(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	seedModelPolicyWorkspace(t, store, "ws")
	putAcceptance(t, store, "ws", "session-1", modelpolicybiz.AcceptanceUserAccepted, "")

	// Hammer the row with concurrent automation writes; the single writer
	// connection serializes them but the WHERE guard is what preserves the
	// terminal state, not ordering.
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = store.PutAgentSessionAcceptance(context.Background(), modelpolicybiz.Acceptance{
				WorkspaceID:    "ws",
				AgentSessionID: "session-1",
				State:          modelpolicybiz.AcceptanceAgentClaimed,
			})
			_ = store.PutAgentSessionAcceptance(context.Background(), modelpolicybiz.Acceptance{
				WorkspaceID:    "ws",
				AgentSessionID: "session-1",
				State:          modelpolicybiz.AcceptanceAutoChecked,
				ReviewRunID:    "run-x",
			})
		}()
	}
	wg.Wait()

	if got := getAcceptanceState(t, store, "ws", "session-1"); got != modelpolicybiz.AcceptanceUserAccepted {
		t.Fatalf("state = %q after concurrent automation writes, want sticky user_accepted", got)
	}
}

func TestGetAgentSessionAcceptanceMissingReturnsNoRows(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	seedModelPolicyWorkspace(t, store, "ws")
	_, err := store.GetAgentSessionAcceptance(context.Background(), "ws", "unknown-session")
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("GetAgentSessionAcceptance() error = %v, want sql.ErrNoRows", err)
	}
}

func TestModelPolicyRoundTripAndPlanLookup(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	seedModelPolicyWorkspace(t, store, "ws")

	policy := modelpolicybiz.Policy{
		ID:          "pol-1",
		WorkspaceID: "ws",
		Name:        "Careful",
		Execution:   modelpolicybiz.PlanModelRef{ModelPlanID: "mp-1", Model: "exec"},
		Review:      modelpolicybiz.PlanModelRef{ModelPlanID: "mp-2", Model: "review"},
		ReviewRule: modelpolicybiz.ReviewRule{
			Enabled:                  true,
			Trigger:                  modelpolicybiz.ReviewTriggerOnTaskComplete,
			MaxRunsPerSession:        5,
			MaxTotalTokensPerSession: 123456,
		},
	}
	if err := store.PutModelPolicy(ctx, policy); err != nil {
		t.Fatalf("PutModelPolicy() error = %v", err)
	}

	got, err := store.GetModelPolicy(ctx, "ws", "pol-1")
	if err != nil {
		t.Fatalf("GetModelPolicy() error = %v", err)
	}
	if got.Name != "Careful" || got.Execution.ModelPlanID != "mp-1" || got.Review.Model != "review" {
		t.Fatalf("policy = %#v, want round-tripped fields", got)
	}
	if !got.ReviewRule.Enabled || got.ReviewRule.MaxRunsPerSession != 5 || got.ReviewRule.MaxTotalTokensPerSession != 123456 {
		t.Fatalf("review rule = %#v, want round-tripped values", got.ReviewRule)
	}

	// Plan lookup finds the policy through any role so deletion stays guarded.
	byExec, err := store.ListModelPoliciesByPlan(ctx, "ws", "mp-1")
	if err != nil {
		t.Fatalf("ListModelPoliciesByPlan(mp-1) error = %v", err)
	}
	byReview, err := store.ListModelPoliciesByPlan(ctx, "ws", "mp-2")
	if err != nil {
		t.Fatalf("ListModelPoliciesByPlan(mp-2) error = %v", err)
	}
	if len(byExec) != 1 || len(byReview) != 1 {
		t.Fatalf("plan lookups = exec:%d review:%d, want 1 each", len(byExec), len(byReview))
	}

	// Missing policy is a typed not-found.
	if _, err := store.GetModelPolicy(ctx, "ws", "pol-missing"); !errors.Is(err, ErrModelPolicyNotFound) {
		t.Fatalf("GetModelPolicy(missing) error = %v, want ErrModelPolicyNotFound", err)
	}
}
