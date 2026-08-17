package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func TestEditRetrySagaPreservesNonTextAndUsesDirectReceipt(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	result, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-1",
			ExpectedHistoryRevision: 0,
		},
	)
	if err != nil {
		t.Fatalf("EditRetry() error = %v", err)
	}
	if result.State != agenthost.EditRetryStateCompleted ||
		result.HistoryRevision != 2 || result.ReplacementTurnID == "" {
		t.Fatalf("EditRetry() result = %#v", result)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != 1 || runtime.execCalls != 1 || runtime.historyReads != 1 {
		t.Fatalf(
			"provider calls rollback=%d exec=%d reads=%d, want 1,1,1",
			runtime.rollbackCalls, runtime.execCalls, runtime.historyReads,
		)
	}
	if len(runtime.content) != 3 ||
		runtime.content[0].Text != "edited prompt" ||
		runtime.content[1].AttachmentID != "attachment-1" ||
		runtime.content[2].Path != "README.md" {
		t.Fatalf("replacement content = %#v", runtime.content)
	}
	original, found, err := store.GetTurn(t.Context(), "workspace-1", "session-1", "turn-original")
	if err != nil || !found || len(original.FileChanges) == 0 {
		t.Fatalf("audited original turn = %#v, found=%v error=%v", original, found, err)
	}
}

func TestEditRetrySagaDoesNotRedispatchAmbiguousRollback(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.rollbackUnknown = true
	runtime.mu.Unlock()
	input := agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-unknown",
		ExpectedHistoryRevision: 0,
	}
	_, firstErr := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original", input,
	)
	if !errors.Is(firstErr, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("first EditRetry() error = %v", firstErr)
	}
	_, secondErr := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original", input,
	)
	if !errors.Is(secondErr, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("second EditRetry() error = %v", secondErr)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.rollbackCalls != 1 || runtime.execCalls != 0 {
		t.Fatalf("provider calls rollback=%d exec=%d, want 1,0", runtime.rollbackCalls, runtime.execCalls)
	}
}

func TestEditRetryFenceBlocksOrdinarySendButAllowsTypedGoalControl(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.rollbackUnknown = true
	runtime.mu.Unlock()
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	if _, err := host.EditRetry(t.Context(), ref, "turn-original", agenthost.EditRetryInput{
		EditedText: "edited prompt", ClientOperationID: "edit-fence", ExpectedHistoryRevision: 0,
	}); !errors.Is(err, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("EditRetry() error = %v, want ErrEditRetryInProgress", err)
	}
	if _, err := host.SendInput(t.Context(), ref, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "ordinary send"}},
	}); !errors.Is(err, agenthost.ErrEditRetryInProgress) {
		t.Fatalf("ordinary SendInput() error = %v, want ErrEditRetryInProgress", err)
	}
	result, err := host.SendInput(t.Context(), ref, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "/goal pause"}},
	})
	if err != nil {
		t.Fatalf("typed goal SendInput() error = %v", err)
	}
	if result.Kind != "goalControl" || result.GoalControl == nil {
		t.Fatalf("typed goal SendInput() result = %#v", result)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.goalControlCalls != 1 {
		t.Fatalf("goal-control calls = %d, want 1", runtime.goalControlCalls)
	}
}

func TestEditRetrySagaReconcilesAcceptedReplacementAfterResponseLoss(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.execOutcomeUnknownAccepted = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-response-loss",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want resend pending", err)
	}
	if first.OperationID == "" {
		t.Fatalf("EditRetry() result = %#v, want durable operation", first)
	}
	if first.ReasonCode != agenthost.EditRetryReasonCodeProviderOutcomeUnknown {
		t.Fatalf("EditRetry() reason = %q, want provider outcome unknown", first.ReasonCode)
	}
	recovered, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	)
	if err != nil {
		t.Fatalf("RecoverEditRetry() error = %v", err)
	}
	if recovered.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("RecoverEditRetry() result = %#v, want completed", recovered)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 1 || runtime.reconcileAcceptanceCalls != 1 {
		t.Fatalf(
			"provider exec=%d acceptance reconciles=%d, want 1/1",
			runtime.execCalls,
			runtime.reconcileAcceptanceCalls,
		)
	}
	if got, want := runtime.reconcileAcceptanceInput.RootTurnID, recovered.ReplacementTurnID; got != want {
		t.Fatalf("acceptance root turn id = %q, want %q", got, want)
	}
	if got, want := runtime.reconcileAcceptanceInput.ClientUserMessageID, "edit-retry:"+first.OperationID; got != want {
		t.Fatalf("acceptance client user message id = %q, want %q", got, want)
	}
	if runtime.reconcileAcceptanceInput.ClientUserMessageID == runtime.reconcileAcceptanceInput.RootTurnID {
		t.Fatal("provider correlation identity reused canonical replacement turn id")
	}
}

func TestEditRetrySagaRetriesReplacementOnlyAfterAuthoritativeAbsence(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-absent",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want resend pending", err)
	}
	if _, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	); !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("reconcile error = %v, want resend pending", err)
	}
	runtime.mu.Lock()
	if runtime.execCalls != 1 {
		t.Fatalf("reconcile exec calls = %d, want 1", runtime.execCalls)
	}
	runtime.mu.Unlock()
	retried, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	)
	if err != nil {
		t.Fatalf("retry replacement error = %v", err)
	}
	if retried.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("retry replacement result = %#v, want completed", retried)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 2 || runtime.rollbackCalls != 1 {
		t.Fatalf(
			"provider exec=%d rollback=%d, want 2/1",
			runtime.execCalls,
			runtime.rollbackCalls,
		)
	}
}

func TestEditRetrySagaCanRetryReplacementAfterSecondAuthoritativeAbsence(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-absent-twice",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want resend pending", err)
	}
	if _, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	); !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("first reconcile error = %v, want resend pending", err)
	}
	runtime.mu.Lock()
	runtime.execOutcomeUnknown = true
	runtime.mu.Unlock()
	if _, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	); !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("first retry error = %v, want resend pending", err)
	}
	if _, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionReconcile,
	); !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("second reconcile error = %v, want resend pending", err)
	}
	retried, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	)
	if err != nil || retried.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("second retry result = %#v error=%v, want completed", retried, err)
	}
	operation, found, err := store.GetRuntimeOperation(
		t.Context(), "workspace-1", first.OperationID,
	)
	if err != nil || !found {
		t.Fatalf("GetRuntimeOperation() found=%v error=%v", found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	if err != nil || payload.DispatchAttempt != 3 {
		t.Fatalf("replacement dispatch attempt=%d error=%v, want 3", payload.DispatchAttempt, err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 3 || runtime.rollbackCalls != 1 {
		t.Fatalf(
			"provider exec=%d rollback=%d, want 3/1",
			runtime.execCalls,
			runtime.rollbackCalls,
		)
	}
}

func TestEditRetrySagaRetriesDefinitivelyNotDispatchedReplacement(t *testing.T) {
	host, _, runtime := newHostEditRetryFixture(t)
	runtime.mu.Lock()
	runtime.execNotDispatchedBeforeTurn = true
	runtime.mu.Unlock()
	first, err := host.EditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		"turn-original",
		agenthost.EditRetryInput{
			EditedText: "edited prompt", ClientOperationID: "edit-not-dispatched",
			ExpectedHistoryRevision: 0,
		},
	)
	if !errors.Is(err, agenthost.ErrEditRetryResendPending) {
		t.Fatalf("EditRetry() error = %v, want resend pending", err)
	}
	retried, err := host.RecoverEditRetry(
		t.Context(),
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"},
		first.OperationID,
		agenthost.EditRetryRecoveryActionRetryReplacement,
	)
	if err != nil {
		t.Fatalf("retry replacement error = %v", err)
	}
	if retried.State != agenthost.EditRetryStateCompleted {
		t.Fatalf("retry replacement result = %#v, want completed", retried)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 2 || runtime.rollbackCalls != 1 {
		t.Fatalf(
			"provider exec=%d rollback=%d, want 2/1",
			runtime.execCalls,
			runtime.rollbackCalls,
		)
	}
}

func newHostEditRetryFixture(t *testing.T) (*agenthost.Host, *storesqlite.Store, *hostEditRetryRuntime) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "edit-retry.db"))
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
		ProviderSessionID: "thread-1", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 2,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			TurnID: "turn-original", Phase: storesqlite.TurnPhaseRunning,
			Origin: storesqlite.TurnOriginUserPrompt, StartedAtUnixMS: 2, OccurredAtUnixMS: 2,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "session-1",
			RootTurnID: "turn-original", ProviderTurnID: "provider-original",
			Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 2,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 3,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			TurnID: "turn-original", Phase: storesqlite.TurnPhaseSettled,
			Outcome: storesqlite.TurnOutcomeCompleted, Origin: storesqlite.TurnOriginUserPrompt,
			FileChanges:     map[string]any{"files": []any{"changed.txt"}},
			SettledAtUnixMS: 3, OccurredAtUnixMS: 3,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: "workspace-1", RootAgentSessionID: "session-1",
			RootTurnID: "turn-original", ProviderTurnID: "provider-original",
			Phase:   storesqlite.RootProviderTurnPhaseCompleted,
			Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RecordTurnSubmission(t.Context(), storesqlite.TurnSubmission{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-original",
		ContentJSON:   `[{"type":"text","text":"original"},{"type":"image","mimeType":"image/png","attachmentId":"attachment-1"},{"type":"mention","name":"README","path":"README.md"}]`,
		DisplayPrompt: "original", CapabilityRefsJSON: `[]`,
		TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-original",
		CreatedAtUnixMS: 3, UpdatedAtUnixMS: 3,
	}); err != nil {
		t.Fatal(err)
	}
	runtime := &hostEditRetryRuntime{
		store: store, providerTurns: []agenthost.RuntimeHistoryTurn{{ID: "provider-original"}},
	}
	host := agenthost.New(agenthost.Config{
		CanonicalStore:  sqliteCanonicalStore{Store: store},
		TurnSubmissions: store, EffectiveHistory: store, RuntimeOperations: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "worker-1",
	})
	return host, store, runtime
}

type hostEditRetryRuntime struct {
	mu                          sync.Mutex
	store                       *storesqlite.Store
	providerTurns               []agenthost.RuntimeHistoryTurn
	rollbackCalls               int
	execCalls                   int
	historyReads                int
	rollbackUnknown             bool
	execOutcomeUnknown          bool
	execOutcomeUnknownAccepted  bool
	execNotDispatchedBeforeTurn bool
	guidanceMismatch            bool
	guidanceTargetInactive      bool
	guidancePreflightFailure    bool
	guidanceProviderCalls       int
	guidanceTransportFailure    bool
	reconcileAcceptanceCalls    int
	reconcileAcceptanceInput    agenthost.RuntimeProviderTurnAcceptanceInput
	goalControlCalls            int
	content                     []agenthost.PromptContentBlock
}

func (*hostEditRetryRuntime) Start(context.Context, agenthost.RuntimeStartInput) (agenthost.RuntimeStartResult, error) {
	return agenthost.RuntimeStartResult{}, nil
}
func (r *hostEditRetryRuntime) Resume(context.Context, agenthost.RuntimeResumeInput) (agenthost.ProviderRuntimeSession, error) {
	return r.session(), nil
}
func (r *hostEditRetryRuntime) Session(string, string) (agenthost.ProviderRuntimeSession, bool) {
	return r.session(), true
}
func (*hostEditRetryRuntime) session() agenthost.ProviderRuntimeSession {
	return agenthost.ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		ProviderSessionID: "thread-1", InitialTitleEstablished: true,
	}
}
func (*hostEditRetryRuntime) CanResume(agenthost.RuntimeResumeInput) bool { return true }
func (r *hostEditRetryRuntime) Exec(ctx context.Context, input agenthost.RuntimeExecInput) (agenthost.RuntimeExecResult, error) {
	r.mu.Lock()
	r.execCalls++
	r.content = append([]agenthost.PromptContentBlock(nil), input.Content...)
	providerTurnID := "provider-" + input.TurnID
	outcomeUnknown := r.execOutcomeUnknown
	outcomeUnknownAccepted := r.execOutcomeUnknownAccepted
	notDispatchedBeforeTurn := r.execNotDispatchedBeforeTurn
	guidanceMismatch := r.guidanceMismatch
	guidanceTargetInactive := r.guidanceTargetInactive
	guidancePreflightFailure := r.guidancePreflightFailure
	guidanceTransportFailure := r.guidanceTransportFailure
	r.execOutcomeUnknown = false
	r.execOutcomeUnknownAccepted = false
	r.execNotDispatchedBeforeTurn = false
	r.guidanceMismatch = false
	r.guidanceTargetInactive = false
	r.guidancePreflightFailure = false
	if input.Guidance && (guidanceMismatch || guidanceTargetInactive) {
		r.mu.Unlock()
		// The runtime adapter proves the exact target is inactive before entering
		// the provider. Model both a changed active turn and the settle race where
		// no active turn remains with the same Host sentinel/disposition contract.
		return agenthost.RuntimeExecResult{
			TurnID: input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionNotDispatched,
			},
		}, fmt.Errorf("%w: exact guidance target is inactive before provider admission", agenthost.ErrActiveTurnTargetMismatch)
	}
	if input.Guidance && guidancePreflightFailure {
		r.mu.Unlock()
		return agenthost.RuntimeExecResult{
			TurnID: input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionNotDispatched,
			},
		}, errors.New("guidance adapter preflight failed before provider dispatch")
	}
	if input.Guidance {
		r.guidanceProviderCalls++
	}
	if !outcomeUnknown || outcomeUnknownAccepted {
		if !notDispatchedBeforeTurn {
			r.providerTurns = append(r.providerTurns, agenthost.RuntimeHistoryTurn{
				ID: providerTurnID, ClientUserMessageID: input.ClientSubmitID,
			})
		}
	}
	r.mu.Unlock()
	if input.Guidance && guidanceTransportFailure {
		return agenthost.RuntimeExecResult{
			TurnID: input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown,
			},
		}, errors.New("guidance transport failed after provider admission")
	}
	if notDispatchedBeforeTurn {
		return agenthost.RuntimeExecResult{
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionNotDispatched,
			},
		}, errors.New("turn/start was not dispatched")
	}
	if _, _, err := r.store.RecordTurnTransition(ctx, storesqlite.TurnTransition{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, Phase: storesqlite.TurnPhaseSubmitted,
		Origin: storesqlite.TurnOriginUserPrompt, OccurredAtUnixMS: 10,
	}); err != nil {
		return agenthost.RuntimeExecResult{}, err
	}
	if outcomeUnknown {
		if !outcomeUnknownAccepted {
			if _, _, settleErr := r.store.RecordTurnTransition(
				ctx,
				storesqlite.TurnTransition{
					WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
					TurnID: input.TurnID, Phase: storesqlite.TurnPhaseSettled,
					Outcome: storesqlite.TurnOutcomeFailed,
					Origin:  storesqlite.TurnOriginUserPrompt, OccurredAtUnixMS: 11,
				},
			); settleErr != nil {
				return agenthost.RuntimeExecResult{}, settleErr
			}
		}
		return agenthost.RuntimeExecResult{
			TurnID: input.TurnID,
			ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
				Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown,
			},
		}, errors.New("turn/start response lost")
	}
	if _, err := r.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "thread-1", OccurredAtUnixMS: 11,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: input.WorkspaceID, RootAgentSessionID: input.AgentSessionID,
			RootTurnID: input.TurnID, ProviderTurnID: providerTurnID,
			Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 11,
		},
	}); err != nil {
		return agenthost.RuntimeExecResult{}, err
	}
	return agenthost.RuntimeExecResult{
		TurnID: input.TurnID,
		ProviderDispatch: agenthost.RuntimeProviderDispatchResult{
			Disposition: agenthost.RuntimeDispatchDispositionApplied,
			Acceptance: &agenthost.RuntimeProviderAcceptanceReceipt{
				ProviderSessionID: "thread-1", ProviderTurnID: providerTurnID,
				Source: agenthost.RuntimeAcceptanceSourceTurnStartResponse,
			},
		},
	}, nil
}
func (r *hostEditRetryRuntime) ReconcileProviderTurnAcceptance(
	ctx context.Context,
	input agenthost.RuntimeProviderTurnAcceptanceInput,
) error {
	r.mu.Lock()
	r.reconcileAcceptanceCalls++
	r.reconcileAcceptanceInput = input
	r.mu.Unlock()
	_, err := r.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
			Kind: storesqlite.SessionKindRoot, Provider: input.Provider,
			ProviderSessionID: input.ExpectedProviderSessionID, OccurredAtUnixMS: 12,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID: input.WorkspaceID, RootAgentSessionID: input.AgentSessionID,
			RootTurnID: input.RootTurnID, ProviderTurnID: input.ExpectedProviderTurnID,
			Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 12,
		},
	})
	return err
}
func (*hostEditRetryRuntime) ValidatePromptContent(context.Context, agenthost.RuntimeExecInput) error {
	return nil
}
func (r *hostEditRetryRuntime) GoalControl(context.Context, agenthost.RuntimeGoalControlInput) (agenthost.RuntimeGoalControlResult, error) {
	r.mu.Lock()
	r.goalControlCalls++
	r.mu.Unlock()
	return agenthost.RuntimeGoalControlResult{}, nil
}
func (*hostEditRetryRuntime) Cancel(context.Context, agenthost.RuntimeCancelInput) (agenthost.RuntimeCancelResult, error) {
	return agenthost.RuntimeCancelResult{}, nil
}
func (*hostEditRetryRuntime) SubmitInteractive(context.Context, agenthost.RuntimeSubmitInteractiveInput) (agenthost.RuntimeSubmitInteractiveResult, error) {
	return agenthost.RuntimeSubmitInteractiveResult{}, nil
}
func (*hostEditRetryRuntime) InteractiveDisposition(string, string, string, string, string) agenthost.RuntimeInteractiveDisposition {
	return agenthost.RuntimeInteractiveDispositionUnknown
}
func (*hostEditRetryRuntime) UpdateSettings(context.Context, agenthost.RuntimeUpdateSettingsInput) error {
	return nil
}
func (r *hostEditRetryRuntime) SetTitle(context.Context, agenthost.RuntimeSetTitleInput) (agenthost.ProviderRuntimeSession, error) {
	return r.session(), nil
}
func (r *hostEditRetryRuntime) SetVisible(context.Context, agenthost.RuntimeSetVisibleInput) (agenthost.ProviderRuntimeSession, error) {
	return r.session(), nil
}
func (*hostEditRetryRuntime) Close(context.Context, agenthost.RuntimeCloseInput) error { return nil }
func (*hostEditRetryRuntime) SupportsEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (bool, error) {
	return true, nil
}
func (r *hostEditRetryRuntime) ReadEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.historyReads++
	return agenthost.RuntimeHistorySnapshot{
		ProviderSessionID: "thread-1",
		Turns:             append([]agenthost.RuntimeHistoryTurn(nil), r.providerTurns...),
	}, nil
}
func (r *hostEditRetryRuntime) RollbackLatestTurn(context.Context, agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rollbackCalls++
	if r.rollbackUnknown {
		return agenthost.RuntimeHistoryMutationResult{
			Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown,
		}, errors.New("rollback response lost")
	}
	r.providerTurns = r.providerTurns[:len(r.providerTurns)-1]
	snapshot := agenthost.RuntimeHistorySnapshot{
		ProviderSessionID: "thread-1",
		Turns:             append([]agenthost.RuntimeHistoryTurn(nil), r.providerTurns...),
	}
	return agenthost.RuntimeHistoryMutationResult{
		Disposition: agenthost.RuntimeDispatchDispositionApplied, Snapshot: &snapshot,
	}, nil
}
