package storesqlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
)

type testTransactionParticipant struct {
	fail   bool
	deltas []TransactionDelta
}

func (p *testTransactionParticipant) Participate(ctx context.Context, writer TransactionWriter, delta TransactionDelta) error {
	p.deltas = append(p.deltas, delta)
	if _, err := writer.ExecContext(ctx, `INSERT INTO test_transaction_markers (transaction_id, mutation_count) VALUES (?, ?)`, delta.TransactionID, len(delta.Mutations)); err != nil {
		return err
	}
	if p.fail {
		return errors.New("participant failure")
	}
	return nil
}

func openParticipantTestStore(t *testing.T, participant *testTransactionParticipant) *Store {
	t.Helper()
	opts := testOptions(&staticProjectPaths{})
	opts.TransactionParticipant = participant
	store := openTestStore(t, opts)
	if _, err := store.db.Exec(`CREATE TABLE test_transaction_markers (transaction_id TEXT PRIMARY KEY, mutation_count INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create participant marker table: %v", err)
	}
	return store
}

func TestTransactionParticipantCommitsWithSessionTurnAndInteraction(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)

	result, err := store.ReportActivityState(context.Background(), ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", OccurredAtUnixMS: 100,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: TurnPhaseWaiting, Origin: TurnOriginProviderInitiated, OccurredAtUnixMS: 100,
		},
		Interaction: &InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
			TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
			OccurredAtUnixMS: 100,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.TransactionID == "" || len(result.CommitDelta.Mutations) != 3 {
		t.Fatalf("commit delta = %#v", result.CommitDelta)
	}
	assertParticipantMutationKinds(t, result.CommitDelta, MutationEntitySession, MutationEntityTurn, MutationEntityInteraction)
	assertParticipantMutationEntityID(t, result.CommitDelta, MutationEntityInteraction, "turn-1\x00request-1")
	encodedSession, err := json.Marshal(result.State.Session)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encodedSession), "CommitTransactionID") || strings.Contains(string(encodedSession), "CommitDelta") || strings.Contains(string(encodedSession), result.TransactionID) {
		t.Fatalf("transient commit metadata leaked into session JSON: %s", encodedSession)
	}
	var mutationCount int
	if err := store.db.QueryRow(`SELECT mutation_count FROM test_transaction_markers WHERE transaction_id = ?`, result.TransactionID).Scan(&mutationCount); err != nil || mutationCount != 3 {
		t.Fatalf("participant marker mutation_count=%d error=%v", mutationCount, err)
	}
}

func TestTransactionParticipantFailureRollsBackCanonicalAndMarkerFacts(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{fail: true}
	store := openParticipantTestStore(t, participant)

	_, err := store.ReportActivityState(context.Background(), ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", OccurredAtUnixMS: 100,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: TurnPhaseWaiting, Origin: TurnOriginProviderInitiated, OccurredAtUnixMS: 100,
		},
		Interaction: &InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
			TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
			OccurredAtUnixMS: 100,
		},
	})
	if err == nil || !strings.Contains(err.Error(), "participant failure") {
		t.Fatalf("ReportActivityState() error = %v", err)
	}
	if _, found, getErr := store.GetSession(context.Background(), "ws-1", "session-1"); getErr != nil || found {
		t.Fatalf("session leaked after rollback found=%v error=%v", found, getErr)
	}
	var markerCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM test_transaction_markers`).Scan(&markerCount); err != nil || markerCount != 0 {
		t.Fatalf("participant markers after rollback=%d error=%v", markerCount, err)
	}
	if len(participant.deltas) != 1 {
		t.Fatalf("participant deltas=%d", len(participant.deltas))
	}
}

func TestTransactionParticipantReceivesMessageVersions(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(context.Background(), TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 1,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v error=%v", accepted, err)
	}

	for index, report := range []SessionMessageReport{
		{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Messages: []MessageUpdate{{MessageID: "message-1", TurnID: "turn-1", Role: "assistant", Kind: "text", Status: "running", OccurredAtUnixMS: 2}},
		},
		{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Messages: []MessageUpdate{{MessageID: "message-1", Status: "completed", ContentDelta: "done", CompletedAtUnixMS: 3}},
		},
	} {
		result, err := store.ReportSessionMessages(context.Background(), report)
		if err != nil {
			t.Fatalf("message report %d: %v", index+1, err)
		}
		if len(result.CommitDelta.Mutations) != 1 || result.CommitDelta.Mutations[0].Version != int64(index+1) {
			t.Fatalf("message report %d delta=%#v", index+1, result.CommitDelta)
		}
	}
}

func TestRuntimeOperationCompletionParticipatesWithCanonicalAndOutboxFacts(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "request-1")
	claimRuntimeOperation(t, store, "operation-1", "worker-a")

	completion, changed, err := store.CompleteInteractiveRuntimeOperation(context.Background(), CompleteInteractiveRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a",
		Disposition: InteractionStatusAnswered, NowUnixMS: 30,
	})
	if err != nil || !changed {
		t.Fatalf("completion changed=%v error=%v", changed, err)
	}
	if completion.TransactionID == "" || completion.Event.ID == 0 {
		t.Fatalf("completion=%#v", completion)
	}
	assertParticipantMutationKinds(t, completion.CommitDelta,
		MutationEntityRuntimeOperation, MutationEntityRuntimeEvent, MutationEntityInteraction)
	assertParticipantMutationEntityID(t, completion.CommitDelta, MutationEntityInteraction, "turn-1\x00request-1")
}

func TestRuntimeOperationCompletionRollsBackWhenParticipantFails(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "request-1")
	claimRuntimeOperation(t, store, "operation-1", "worker-a")
	var markerCountBefore int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM test_transaction_markers`).Scan(&markerCountBefore); err != nil {
		t.Fatal(err)
	}
	participant.fail = true

	_, _, err := store.CompleteInteractiveRuntimeOperation(context.Background(), CompleteInteractiveRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a",
		Disposition: InteractionStatusAnswered, NowUnixMS: 30,
	})
	if err == nil || !strings.Contains(err.Error(), "participant failure") {
		t.Fatalf("completion error=%v", err)
	}
	interactions, listErr := store.ListSessionInteractions(context.Background(), ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	})
	operation, found, getErr := store.GetRuntimeOperation(context.Background(), "ws-1", "operation-1")
	if listErr != nil || len(interactions) != 1 || interactions[0].Status != InteractionStatusPending {
		t.Fatalf("interactions after rollback=%#v error=%v", interactions, listErr)
	}
	if getErr != nil || !found || operation.Status != RuntimeOperationStatusLeased {
		t.Fatalf("operation after rollback=%#v found=%v error=%v", operation, found, getErr)
	}
	var markerCountAfter int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM test_transaction_markers`).Scan(&markerCountAfter); err != nil || markerCountAfter != markerCountBefore {
		t.Fatalf("marker count before=%d after=%d error=%v", markerCountBefore, markerCountAfter, err)
	}
}

func TestGoalPrepareParticipatesWithIntentStateAndAudit(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	if _, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}

	operation, state, created, err := store.PrepareGoalControlOperation(context.Background(), GoalControlOperationPrepare{
		OperationID: "goal-op-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Action: "set", Objective: "ship it", ClientSubmitID: "submit-1", OccurredAtUnixMS: 2,
	})
	if err != nil || !created {
		t.Fatalf("goal prepare created=%v error=%v", created, err)
	}
	if operation.CommitTransactionID == "" || state.CommitTransactionID != operation.CommitTransactionID {
		t.Fatalf("operation=%#v state=%#v", operation, state)
	}
	assertParticipantMutationKinds(t, operation.CommitDelta,
		MutationEntityGoalOperation, MutationEntityGoalState, MutationEntityMessage)
	for _, mutation := range operation.CommitDelta.Mutations {
		if mutation.EntityKind == MutationEntityMessage && (mutation.EntityID != "goal-control:goal-op-1" || mutation.Version != 1) {
			t.Fatalf("goal audit mutation=%#v", mutation)
		}
	}
}

func TestStaleSettlementRollsBackWhenParticipantFails(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(context.Background(), TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 10,
	}); err != nil || !accepted {
		t.Fatalf("seed stale turn accepted=%v error=%v", accepted, err)
	}
	participant.fail = true

	if _, err := store.SettleStaleTurns(context.Background()); err == nil || !strings.Contains(err.Error(), "participant failure") {
		t.Fatalf("SettleStaleTurns() error=%v", err)
	}
	turn, found, err := store.GetTurn(context.Background(), "ws-1", "session-1", "turn-1")
	if err != nil || !found || turn.Phase != TurnPhaseRunning {
		t.Fatalf("turn after rollback=%#v found=%v error=%v", turn, found, err)
	}
	session, found, err := store.GetSession(context.Background(), "ws-1", "session-1")
	if err != nil || !found || session.ActiveTurnID != "turn-1" {
		t.Fatalf("session after rollback=%#v found=%v error=%v", session, found, err)
	}
}

func TestSessionTitleUpdateRollsBackWhenParticipantFails(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	if _, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex",
		Title: "before", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	participant.fail = true

	if _, _, err := store.UpdateSessionTitle(context.Background(), "ws-1", "session-1", "after"); err == nil {
		t.Fatal("UpdateSessionTitle() error=nil, want participant failure")
	}
	session, found, err := store.GetSession(context.Background(), "ws-1", "session-1")
	if err != nil || !found || session.Title != "before" {
		t.Fatalf("session after rollback=%#v found=%v error=%v", session, found, err)
	}
}

func TestSessionDeleteCommitsDurableMarkerWithTombstone(t *testing.T) {
	t.Parallel()
	participant := &testTransactionParticipant{}
	store := openParticipantTestStore(t, participant)
	if _, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
		Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := store.DeleteSessionWithCommit(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovedSessions != 1 || result.TransactionID == "" {
		t.Fatalf("delete result=%#v", result)
	}
	assertParticipantMutationEntityID(t, result.CommitDelta, MutationEntitySession, "session-1")
	if len(result.CommitDelta.Mutations) != 1 || result.CommitDelta.Mutations[0].Operation != "delete" {
		t.Fatalf("delete delta=%#v", result.CommitDelta)
	}
}

func TestSessionDeleteAndInitializationRollbackPreserveCanonicalFactWhenParticipantFails(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct {
		name string
		run  func(*Store) error
	}{
		{name: "user deletion", run: func(store *Store) error {
			_, err := store.DeleteSessionWithCommit(context.Background(), "ws-1", "session-1")
			return err
		}},
		{name: "initialization compensation", run: func(store *Store) error {
			_, err := store.RollbackRuntimeSessionInitialization(context.Background(), "ws-1", "session-1")
			return err
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			participant := &testTransactionParticipant{}
			store := openParticipantTestStore(t, participant)
			if _, err := store.ReportSessionState(context.Background(), SessionStateReport{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
				Provider: "codex", OccurredAtUnixMS: 1,
			}); err != nil {
				t.Fatal(err)
			}
			participant.fail = true

			if err := testCase.run(store); err == nil || !strings.Contains(err.Error(), "participant failure") {
				t.Fatalf("mutation error=%v", err)
			}
			if _, found, err := store.GetSession(context.Background(), "ws-1", "session-1"); err != nil || !found {
				t.Fatalf("session after participant rollback found=%v error=%v", found, err)
			}
		})
	}
}

func assertParticipantMutationKinds(t *testing.T, delta TransactionDelta, want ...string) {
	t.Helper()
	got := make([]string, 0, len(delta.Mutations))
	for index, mutation := range delta.Mutations {
		if mutation.MutationID != fmt.Sprintf("%s:%d", delta.TransactionID, index+1) {
			t.Fatalf("mutation %d id=%q transaction=%q", index, mutation.MutationID, delta.TransactionID)
		}
		got = append(got, mutation.EntityKind)
	}
	sort.Strings(got)
	sort.Strings(want)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("mutation kinds=%v want=%v", got, want)
	}
}

func assertParticipantMutationEntityID(t *testing.T, delta TransactionDelta, entityKind, want string) {
	t.Helper()
	for _, mutation := range delta.Mutations {
		if mutation.EntityKind == entityKind {
			if mutation.EntityID != want {
				t.Fatalf("%s mutation entity id=%q, want %q", entityKind, mutation.EntityID, want)
			}
			return
		}
	}
	t.Fatalf("%s mutation not found in %#v", entityKind, delta.Mutations)
}
