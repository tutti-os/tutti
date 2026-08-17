package agenthost

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

type interactiveFollowUpRuntime struct {
	RuntimeController
	store        *storesqlite.Store
	activeTurnID string
	sessionFound bool

	mu                     sync.Mutex
	execInputs             []RuntimeExecInput
	submitInteractiveCalls int
}

type interactiveFollowUpCanonicalStore struct {
	*storesqlite.Store
}

func (interactiveFollowUpCanonicalStore) InitializeRuntimeSession(context.Context, RuntimeSessionInitialization) (storesqlite.Session, error) {
	return storesqlite.Session{}, nil
}

func (r *interactiveFollowUpRuntime) Session(workspaceID, agentSessionID string) (ProviderRuntimeSession, bool) {
	r.mu.Lock()
	activeTurnID := r.activeTurnID
	sessionFound := r.sessionFound
	r.mu.Unlock()
	var lifecycle *TurnLifecycle
	if activeTurnID != "" {
		lifecycle = &TurnLifecycle{ActiveTurnID: &activeTurnID}
	}
	return ProviderRuntimeSession{
		WorkspaceID: workspaceID, ID: agentSessionID, Provider: "codex",
		ProviderSessionID: "provider-session-1",
		TurnLifecycle:     lifecycle,
	}, sessionFound && workspaceID == "workspace-1" && agentSessionID == "session-1"
}

func (r *interactiveFollowUpRuntime) SubmitInteractive(_ context.Context, input RuntimeSubmitInteractiveInput) (RuntimeSubmitInteractiveResult, error) {
	r.mu.Lock()
	r.activeTurnID = ""
	r.submitInteractiveCalls++
	r.mu.Unlock()
	if _, _, err := r.store.RecordTurnTransition(context.Background(), storesqlite.TurnTransition{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, Phase: storesqlite.TurnPhaseSettled,
		Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 10,
	}); err != nil {
		return RuntimeSubmitInteractiveResult{}, err
	}
	return RuntimeSubmitInteractiveResult{
		Disposition:    RuntimeInteractiveDispositionAnswered,
		FollowUpPrompt: "Please split the work into smaller steps.",
	}, nil
}

func (*interactiveFollowUpRuntime) ValidatePromptContent(context.Context, RuntimeExecInput) error {
	return nil
}

func (r *interactiveFollowUpRuntime) Exec(_ context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	r.mu.Lock()
	r.execInputs = append(r.execInputs, input)
	r.mu.Unlock()
	if _, _, err := r.store.RecordTurnTransition(context.Background(), storesqlite.TurnTransition{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, Phase: storesqlite.TurnPhaseSubmitted,
		Origin: storesqlite.TurnOriginUserPrompt, OccurredAtUnixMS: 11,
	}); err != nil {
		return RuntimeExecResult{}, err
	}
	return RuntimeExecResult{
		TurnID: input.TurnID,
		ProviderDispatch: RuntimeProviderDispatchResult{
			Disposition: RuntimeDispatchDispositionApplied,
		},
	}, nil
}

func (r *interactiveFollowUpRuntime) recordedExecInputs() []RuntimeExecInput {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RuntimeExecInput(nil), r.execInputs...)
}

func (r *interactiveFollowUpRuntime) recordedSubmitInteractiveCalls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.submitInteractiveCalls
}

func newInteractiveFollowUpStore(t *testing.T) *storesqlite.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "interactive-follow-up.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(t.Context(), storesqlite.SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
		ProviderSessionID: "provider-session-1", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseWaiting, OccurredAtUnixMS: 2,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.UpsertInteraction(t.Context(), storesqlite.InteractionUpsert{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1",
		RequestID: "request-1", Kind: storesqlite.InteractionKindQuestion,
		Status: storesqlite.InteractionStatusPending, OccurredAtUnixMS: 3,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE workspace_agent_turns
SET root_provider_turn_id = 'provider-turn-1', root_provider_turn_phase = 'running',
    root_provider_turn_updated_at_unix_ms = 4
WHERE workspace_id = 'workspace-1' AND agent_session_id = 'session-1' AND turn_id = 'turn-1'`); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestSubmitInteractiveRoutesRuntimeFollowUpThroughHostSendInput(t *testing.T) {
	store := newInteractiveFollowUpStore(t)

	runtime := &interactiveFollowUpRuntime{store: store, activeTurnID: "turn-1", sessionFound: true}
	host := New(Config{
		CanonicalStore: interactiveFollowUpCanonicalStore{Store: store}, Runtime: runtime, RuntimeOperations: store,
		OperationOwner: "worker-1",
	})
	optionID := "deny"
	result, err := host.SubmitInteractive(t.Context(), InteractionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		TurnID: "turn-1", RequestID: "request-1",
	}, SubmitInteractiveInput{OptionID: &optionID})
	if err != nil {
		t.Fatalf("SubmitInteractive() error = %v", err)
	}
	if result.Disposition != RuntimeInteractiveDispositionAnswered ||
		result.Operation.Status != storesqlite.RuntimeOperationStatusCompleted {
		t.Fatalf("SubmitInteractive() result = %#v", result)
	}

	execInputs := runtime.recordedExecInputs()
	if len(execInputs) != 1 {
		t.Fatalf("follow-up Exec calls = %d, want 1", len(execInputs))
	}
	if got := execInputs[0].ClientSubmitID; got != "interactive-deny:"+result.Operation.OperationID {
		t.Fatalf("follow-up ClientSubmitID = %q, want stable operation identity", got)
	}
	if len(execInputs[0].Content) != 1 || execInputs[0].Content[0].Text != "Please split the work into smaller steps." {
		t.Fatalf("follow-up content = %#v", execInputs[0].Content)
	}

	claim, found, err := store.GetSubmitClaim(t.Context(), "workspace-1", "session-1", execInputs[0].ClientSubmitID)
	if err != nil || !found || claim.Status != "accepted" || claim.TurnID == "" {
		t.Fatalf("follow-up submit claim = %#v, found=%v, error=%v", claim, found, err)
	}

	if _, err := host.SendInput(t.Context(), SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, SendInput{
		ClientSubmitID: execInputs[0].ClientSubmitID,
		Content:        []PromptContentBlock{{Type: "text", Text: "Please split the work into smaller steps."}},
	}); err != nil {
		t.Fatalf("replaying follow-up SendInput() error = %v", err)
	}
	if got := len(runtime.recordedExecInputs()); got != 1 {
		t.Fatalf("replayed follow-up Exec calls = %d, want 1", got)
	}
}

func TestRecoverInteractiveFollowUpUsesCheckpointedDispositionWithoutRuntimeSession(t *testing.T) {
	store := newInteractiveFollowUpStore(t)
	operation, _, _, err := store.PrepareInteractiveRuntimeOperation(t.Context(), storesqlite.RuntimeOperationPrepare{
		OperationID: "operation-recover-follow-up", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Kind: storesqlite.RuntimeOperationKindInteractiveResponse, TurnID: "turn-1", RequestID: "request-1",
		Payload: map[string]any{"action": "", "optionId": "deny", "payload": map[string]any(nil)}, OccurredAtMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := store.ClaimRuntimeOperationLease(t.Context(), storesqlite.ClaimRuntimeOperationLeaseInput{
		WorkspaceID: "workspace-1", OperationID: operation.OperationID, LeaseOwner: "dead-worker",
		NowUnixMS: 20, LeaseExpiresAtMS: 100,
	}); err != nil || !claimed {
		t.Fatalf("claim operation = claimed=%v error=%v", claimed, err)
	}
	if _, changed, err := store.CheckpointRuntimeOperation(t.Context(), storesqlite.CheckpointRuntimeOperationInput{
		WorkspaceID: "workspace-1", OperationID: operation.OperationID, LeaseOwner: "dead-worker", NowUnixMS: 30,
		Payload: map[string]any{
			"action": "", "optionId": "deny", "payload": map[string]any(nil),
			"followUpPrompt":         "Please split the work into smaller steps.",
			"followUpClientSubmitId": "interactive-deny:operation-recover-follow-up",
			"followUpDisposition":    storesqlite.InteractionStatusAnswered,
		},
	}); err != nil || !changed {
		t.Fatalf("checkpoint operation = changed=%v error=%v", changed, err)
	}

	runtime := &interactiveFollowUpRuntime{store: store, sessionFound: false}
	host := New(Config{
		CanonicalStore: interactiveFollowUpCanonicalStore{Store: store}, Runtime: runtime, RuntimeOperations: store,
		OperationOwner: "recovery-worker", Clock: fixedClock{at: time.UnixMilli(1_000)},
	})
	if err := host.RecoverRuntimeOperations(t.Context()); err != nil {
		t.Fatalf("RecoverRuntimeOperations() error = %v", err)
	}
	recovered, found, err := store.GetRuntimeOperation(t.Context(), "workspace-1", operation.OperationID)
	if err != nil || !found {
		t.Fatalf("recovered operation = %#v found=%v error=%v", recovered, found, err)
	}
	if recovered.Status != storesqlite.RuntimeOperationStatusPrepared || recovered.NextAttemptAtMS <= 1_000 {
		t.Fatalf("recovered operation = %#v, want retryable prepared state", recovered)
	}
	if got := runtime.recordedSubmitInteractiveCalls(); got != 0 {
		t.Fatalf("recovery SubmitInteractive calls = %d, want 0", got)
	}
}
