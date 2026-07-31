package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type sessionForkCapabilityStore struct {
	agenthost.SessionForkStore
	workspaceID, sourceSessionID, throughTurnID string
}

func TestNormalizeSessionForkErrorPreservesBoundaryReason(t *testing.T) {
	input := &storesqlite.SessionForkBoundaryError{
		Reason: storesqlite.SessionForkBoundaryReasonAttachmentUnsupported,
	}
	normalized := normalizeSessionForkError(input)
	if !errors.Is(normalized, ErrSessionForkConflict) ||
		!errors.Is(normalized, storesqlite.ErrSessionForkTurnState) {
		t.Fatalf("normalized error=%v", normalized)
	}
	var reasoner interface{ ForkBoundaryReason() string }
	if !errors.As(normalized, &reasoner) ||
		reasoner.ForkBoundaryReason() !=
			string(storesqlite.SessionForkBoundaryReasonAttachmentUnsupported) {
		t.Fatalf("boundary reason not preserved: %v", normalized)
	}
}

func (s *sessionForkCapabilityStore) CheckSessionForkThroughTurn(
	_ context.Context,
	workspaceID, sourceSessionID, throughTurnID string,
) (storesqlite.SessionForkBoundary, bool, error) {
	s.workspaceID, s.sourceSessionID, s.throughTurnID = workspaceID, sourceSessionID, throughTurnID
	return storesqlite.SessionForkBoundary{
		Session: storesqlite.Session{
			ID: sourceSessionID, WorkspaceID: workspaceID,
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "provider-session-1",
		},
	}, true, nil
}

func (s *sessionForkCapabilityStore) GetSessionForkSource(
	_ context.Context,
	workspaceID, sourceSessionID string,
) (storesqlite.Session, bool, error) {
	s.workspaceID, s.sourceSessionID = workspaceID, sourceSessionID
	return storesqlite.Session{
		ID: sourceSessionID, WorkspaceID: workspaceID,
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
		ProviderSessionID: "provider-session-1",
	}, true, nil
}

func (s *sessionForkCapabilityStore) ListSessionForkTurnIdentities(
	_ context.Context,
	workspaceID, sourceSessionID string,
) ([]storesqlite.SessionForkTurnIdentity, error) {
	s.workspaceID, s.sourceSessionID = workspaceID, sourceSessionID
	return []storesqlite.SessionForkTurnIdentity{{
		TurnID:         "turn-7",
		ProviderTurnID: "provider-turn-7",
		Phase:          storesqlite.TurnPhaseSettled,
	}}, nil
}

type sessionForkCapabilityRuntime struct {
	agenthost.SessionForkRuntime
	source agenthost.ProviderRuntimeSession
	calls  int
}

func (r *sessionForkCapabilityRuntime) ResolveSessionFork(
	_ context.Context,
	source agenthost.ProviderRuntimeSession,
) (agenthost.SessionForkDriverDescriptor, error) {
	r.calls++
	r.source = source
	return agenthost.SessionForkDriverDescriptor{
		Kind:             "native",
		Version:          "v1",
		StateBindingMode: agenthost.SessionForkStateBindingProviderOwned,
		ThroughTurn:      true,
	}, nil
}

func TestWithSessionForkCapabilitiesUsesProviderSessionCapability(t *testing.T) {
	store := &sessionForkCapabilityStore{}
	runtime := &sessionForkCapabilityRuntime{}
	service := &Service{}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionForks: store, SessionForkRuntime: runtime,
	}))

	projected := service.withSessionForkCapabilities(
		t.Context(),
		"workspace-1",
		Session{
			ID: "source-1", Kind: storesqlite.SessionKindRoot,
			LatestTurn: &storesqlite.Turn{
				TurnID: "turn-7", Phase: storesqlite.TurnPhaseSettled,
			},
		},
	)
	if !projected.LifecycleCapabilities.ForkThroughTurn {
		t.Fatal("ForkThroughTurn = false, want exact runtime capability")
	}
	if projected.LifecycleCapabilities.Fork {
		t.Fatal("Fork = true, want unsupported full-session capability")
	}
	if store.workspaceID != "workspace-1" || store.sourceSessionID != "source-1" {
		t.Fatalf(
			"capability input = workspace=%q source=%q turn=%q",
			store.workspaceID,
			store.sourceSessionID,
			store.throughTurnID,
		)
	}
	if runtime.source.ProviderSessionID != "provider-session-1" {
		t.Fatalf("runtime source = %#v", runtime.source)
	}
}

type sessionForkListProjectionStore struct {
	agenthost.SessionForkStore
	sourceReads  int
	lineageReads int
}

func (s *sessionForkListProjectionStore) GetSessionForkSource(
	_ context.Context,
	_, _ string,
) (storesqlite.Session, bool, error) {
	s.sourceReads++
	return storesqlite.Session{}, false, nil
}

func (s *sessionForkListProjectionStore) GetSessionForkLineage(
	_ context.Context,
	_, _ string,
) (storesqlite.SessionForkLineage, bool, error) {
	s.lineageReads++
	return storesqlite.SessionForkLineage{}, false, nil
}

func TestProtocolV2BatchProjectionDoesNotProbeSessionForkCapabilities(t *testing.T) {
	store := &sessionForkListProjectionStore{}
	runtime := &sessionForkCapabilityRuntime{}
	service := &Service{TurnStore: failingTurnStore{}}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionForks: store, SessionForkRuntime: runtime,
	}))

	projected, err := service.withProtocolV2TurnStates(
		t.Context(),
		"workspace-1",
		[]Session{{
			ID: "source-1", Kind: storesqlite.SessionKindRoot,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(projected) != 1 {
		t.Fatalf("projected sessions=%d, want 1", len(projected))
	}
	if runtime.calls != 0 || store.sourceReads != 0 {
		t.Fatalf(
			"list projection probed fork capability: runtime=%d sourceReads=%d",
			runtime.calls,
			store.sourceReads,
		)
	}
	if store.lineageReads != 1 {
		t.Fatalf("lineage reads=%d, want 1 canonical read", store.lineageReads)
	}
}

func TestMessageHydrationProjectionDoesNotProbeSessionForkCapabilities(t *testing.T) {
	store := &sessionForkListProjectionStore{}
	runtime := &sessionForkCapabilityRuntime{}
	service := &Service{}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionForks: store, SessionForkRuntime: runtime,
	}))

	projected, err := service.withProtocolV2TurnStateProjectionOptions(
		t.Context(),
		"workspace-1",
		Session{
			ID: "source-1", Kind: storesqlite.SessionKindRoot,
		},
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.calls != 0 || store.sourceReads != 0 {
		t.Fatalf(
			"message hydration projection probed fork capability: runtime=%d sourceReads=%d",
			runtime.calls,
			store.sourceReads,
		)
	}
	if projected.LifecycleCapabilities.Fork ||
		projected.LifecycleCapabilities.ForkThroughTurn {
		t.Fatalf(
			"message hydration lifecycle capabilities=%#v, want fail-closed projection",
			projected.LifecycleCapabilities,
		)
	}
	if store.lineageReads != 1 {
		t.Fatalf("lineage reads=%d, want one canonical read", store.lineageReads)
	}
}

func TestSessionForkContextPolicyRejectsWorktreeIsolation(t *testing.T) {
	policy := serviceHostSessionForkContextPolicy{}
	_, err := policy.PrepareSessionForkTargetContext(t.Context(), storesqlite.Session{
		Cwd: "/tmp/source-worktree",
		InternalRuntimeContext: map[string]any{
			worktreeIsolationContextKey: map[string]any{
				"mode": "worktree",
			},
		},
	}, agenthost.ProviderRuntimeSession{Cwd: "/prepared"})
	if err != agenthost.ErrSessionForkUnsupported {
		t.Fatalf("PrepareSessionForkTargetContext() error=%v", err)
	}
}

func TestSessionForkContextPolicyPreservesNonOwnedRuntimeFacts(t *testing.T) {
	policy := serviceHostSessionForkContextPolicy{
		runtimePreparer: runtimeprep.NewDefaultPreparer(t.TempDir()),
	}
	target, err := policy.PrepareSessionForkTargetContext(t.Context(), storesqlite.Session{
		Provider: "codex",
		Cwd:      "/project",
		InternalRuntimeContext: map[string]any{
			sessionRuntimeSnapshotContextKey: map[string]any{"version": float64(1)},
			"tuttiInitialTitleEstablished":   true,
		},
	}, agenthost.ProviderRuntimeSession{
		Cwd: "/prepared-project",
		RuntimeContext: map[string]any{
			sessionRuntimeSnapshotContextKey: map[string]any{"version": float64(2)},
			"tuttiInitialTitleEstablished":   true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if target.Cwd != "/prepared-project" ||
		target.RuntimeContext[sessionRuntimeSnapshotContextKey] == nil ||
		target.RuntimeContext["tuttiInitialTitleEstablished"] != true {
		t.Fatalf("target context=%#v", target)
	}
}

func TestSessionForkContextPolicyLeavesBindingModeEnforcementToHost(t *testing.T) {
	source := storesqlite.Session{Provider: "codex"}
	prepared := agenthost.ProviderRuntimeSession{Cwd: "/prepared-project"}
	target, err := (serviceHostSessionForkContextPolicy{
		runtimePreparer: fakeRuntimePreparer{},
	}).PrepareSessionForkTargetContext(t.Context(), source, prepared)
	if err != nil || target.Cwd != "/prepared-project" {
		t.Fatalf("policy without provider state binder target=%#v error=%v", target, err)
	}

	target, err = (serviceHostSessionForkContextPolicy{
		runtimePreparer: runtimeprep.NewDefaultPreparer(t.TempDir()),
	}).PrepareSessionForkTargetContext(t.Context(), source, prepared)
	if err != nil || target.Cwd != "/prepared-project" {
		t.Fatalf("policy with provider state binder target=%#v error=%v", target, err)
	}
}

func TestHostPreparationRepairsCommittedCodexForkProviderStateBeforeResume(t *testing.T) {
	store := &serviceSessionForkOperationStore{
		operation: storesqlite.SessionForkOperation{
			OperationID:             "operation-1",
			WorkspaceID:             "workspace-1",
			SourceAgentSessionID:    "source-1",
			TargetAgentSessionID:    "target-1",
			SourceProviderSessionID: "thread-source",
			TargetProviderSessionID: "thread-target",
			Status:                  storesqlite.SessionForkStatusCommitted,
		},
		lineage: storesqlite.SessionForkLineage{
			WorkspaceID:          "workspace-1",
			TargetAgentSessionID: "target-1",
			SourceAgentSessionID: "source-1",
			SourceTurnID:         "turn-1",
			OperationID:          "operation-1",
		},
		session: storesqlite.Session{
			ID: "target-1", WorkspaceID: "workspace-1",
			Provider: "codex", ProviderSessionID: "thread-target",
		},
	}
	preparer := &recordingSessionForkRuntimePreparer{}
	err := (serviceHostPreparation{
		runtimePreparer: preparer,
		sessionForks:    store,
	}).bindCommittedSessionForkProviderState(
		t.Context(),
		agenthost.RuntimePreparationInput{
			WorkspaceID:       "workspace-1",
			AgentSessionID:    "target-1",
			Provider:          "codex",
			ProviderSessionID: "thread-target",
		},
	)
	if err != nil {
		t.Fatalf("bindCommittedSessionForkProviderState() error=%v", err)
	}
	if len(preparer.inputs) != 1 {
		t.Fatalf("provider state repair calls=%d, want 1", len(preparer.inputs))
	}
	if got := preparer.inputs[0]; got.SourceAgentSessionID != "source-1" ||
		got.TargetAgentSessionID != "target-1" ||
		got.SourceProviderSessionID != "thread-source" ||
		got.TargetProviderSessionID != "thread-target" {
		t.Fatalf("provider state repair input=%#v", got)
	}
}

type recordingSessionForkRuntimePreparer struct {
	inputs []runtimeprep.SessionForkProviderStateBindingInput
}

func (*recordingSessionForkRuntimePreparer) SupportsSessionForkProviderStateBinding(
	provider string,
) bool {
	return provider == "codex"
}

func (*recordingSessionForkRuntimePreparer) Prepare(
	context.Context,
	runtimeprep.PrepareInput,
) (runtimeprep.PreparedRuntime, error) {
	return runtimeprep.PreparedRuntime{}, nil
}

func (*recordingSessionForkRuntimePreparer) Cleanup(
	context.Context,
	runtimeprep.CleanupInput,
) error {
	return nil
}

func (p *recordingSessionForkRuntimePreparer) BindSessionForkProviderState(
	_ context.Context,
	input runtimeprep.SessionForkProviderStateBindingInput,
) error {
	p.inputs = append(p.inputs, input)
	return nil
}

func TestWithSessionForkCapabilitiesKeepsProviderCapabilityWhileBusy(t *testing.T) {
	store := &sessionForkCapabilityStore{}
	runtime := &sessionForkCapabilityRuntime{}
	service := &Service{}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionForks: store, SessionForkRuntime: runtime,
	}))
	projected := service.withSessionForkCapabilities(
		t.Context(),
		"workspace-1",
		Session{
			ID: "source-1", Kind: storesqlite.SessionKindRoot,
			LatestTurn: &storesqlite.Turn{
				TurnID: "turn-7", Phase: storesqlite.TurnPhaseRunning,
			},
			ActiveTurnID: "turn-7",
			LifecycleCapabilities: SessionLifecycleCapabilities{
				ForkThroughTurn: false,
			},
		},
	)
	if !projected.LifecycleCapabilities.ForkThroughTurn {
		t.Fatal("ForkThroughTurn = false while provider Session is busy")
	}
}

func TestForkReturnsAcceptedThenExposesDurableProviderOutcome(t *testing.T) {
	for _, test := range []struct {
		name        string
		disposition agenthost.SessionForkDeliveryDisposition
		wantStatus  SessionForkOperationStatus
	}{
		{
			name:        "provider rejection",
			disposition: agenthost.SessionForkDeliveryRejected,
			wantStatus:  SessionForkOperationFailed,
		},
		{
			name:        "unknown delivery",
			disposition: agenthost.SessionForkDeliveryUnknown,
			wantStatus:  SessionForkOperationUnknown,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &serviceSessionForkOperationStore{}
			runtime := &serviceSessionForkOperationRuntime{
				disposition: test.disposition,
				forkErr:     errors.New("provider fork failed"),
			}
			service := &Service{}
			service.SetApplicationHost(agenthost.New(agenthost.Config{
				SessionForks: store, SessionForkRuntime: runtime,
			}))

			operation, err := service.Fork(
				t.Context(),
				"workspace-1",
				"source-1",
				ForkSessionInput{
					TargetAgentSessionID: "target-1",
					RequestID:            "request-1",
					ThroughTurnID:        "turn-7",
				},
			)
			if err != nil {
				t.Fatalf("Fork() error=%v", err)
			}
			if operation.Status != SessionForkOperationAccepted ||
				operation.Phase != "frozen" ||
				operation.OperationID == "" {
				t.Fatalf("Fork() operation=%#v", operation)
			}

			deadline := time.Now().Add(time.Second)
			for operation.Status == SessionForkOperationAccepted &&
				time.Now().Before(deadline) {
				operation, err = service.GetSessionForkOperation(
					t.Context(),
					"workspace-1",
					operation.OperationID,
				)
				if err != nil {
					t.Fatalf("GetSessionForkOperation() error=%v", err)
				}
				if operation.Status == SessionForkOperationAccepted {
					time.Sleep(time.Millisecond)
				}
			}
			if operation.Status != test.wantStatus ||
				operation.Error == nil ||
				*operation.Error != "provider fork failed" {
				t.Fatalf("terminal operation=%#v", operation)
			}
		})
	}
}

func TestPublicSessionForkOperationStatusCollapsesActiveInternalPhases(t *testing.T) {
	for _, test := range []struct {
		internal string
		phase    string
	}{
		{internal: storesqlite.SessionForkStatusPrepared, phase: "frozen"},
		{internal: storesqlite.SessionForkStatusDispatching, phase: "dispatching"},
		{internal: storesqlite.SessionForkStatusProviderAccepted, phase: "materializing"},
	} {
		status, err := publicSessionForkOperationStatus(test.internal)
		if err != nil {
			t.Fatalf("publicSessionForkOperationStatus(%q) error=%v", test.internal, err)
		}
		if status != SessionForkOperationAccepted ||
			publicSessionForkOperationPhase(test.internal) != test.phase {
			t.Fatalf(
				"public fork projection(%q)=status %q phase %q",
				test.internal,
				status,
				publicSessionForkOperationPhase(test.internal),
			)
		}
	}
}

func TestGetSessionForkOperationProjectsImmutableCommittedSessionAfterDeletion(t *testing.T) {
	lineage := storesqlite.SessionForkLineage{
		WorkspaceID: "workspace-1", TargetAgentSessionID: "target-1",
		SourceAgentSessionID: "source-1", SourceTurnID: "turn-7",
		TargetTurnID: "target-turn-7",
		OperationID:  "operation-1", ForkedAtUnixMS: 200,
	}
	forkStore := &serviceSessionForkOperationStore{
		operation: storesqlite.SessionForkOperation{
			OperationID: "operation-1", WorkspaceID: "workspace-1",
			RequestID: "request-1", SourceAgentSessionID: "source-1",
			TargetAgentSessionID: "target-1", SourceTurnID: "turn-7",
			TargetTurnID: "target-turn-7",
			Status:       storesqlite.SessionForkStatusCommitted,
		},
		lineage: lineage,
		session: storesqlite.Session{
			ID: "target-1", WorkspaceID: "workspace-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "provider-target", RailSectionKey: "conversations",
			CreatedAtUnixMS: 100, UpdatedAtUnixMS: 200,
		},
		hideCanonicalLineage: true,
	}
	// Hard purge removes both the canonical child and its cascade-owned lineage
	// row. The committed operation still owns its immutable response projection.
	canonicalStore := &serviceSessionForkCanonicalStore{}
	service := &Service{}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		CanonicalStore: canonicalStore,
		SessionForks:   forkStore,
	}))

	operation, err := service.GetSessionForkOperation(
		t.Context(),
		"workspace-1",
		"operation-1",
	)
	if err != nil {
		t.Fatalf("GetSessionForkOperation() error=%v", err)
	}
	if operation.Status != SessionForkOperationCommitted ||
		operation.Session == nil ||
		operation.Session.ID != "target-1" ||
		operation.Session.RailSectionKey != "conversations" ||
		operation.Session.ForkedFrom == nil ||
		operation.Session.ForkedFrom.OperationID != "operation-1" ||
		operation.Session.ForkedFrom.TargetTurnID != "target-turn-7" ||
		operation.Lineage == nil ||
		operation.Lineage.SourceTurnID != "turn-7" ||
		operation.Lineage.TargetTurnID != "target-turn-7" {
		t.Fatalf("GetSessionForkOperation() operation=%#v", operation)
	}
	if forkStore.acknowledgeCalls != 0 {
		t.Fatalf(
			"GetSessionForkOperation() implicitly acknowledged %d times",
			forkStore.acknowledgeCalls,
		)
	}
}

func TestAcknowledgeSessionForkOperationProjectsImmutableCommittedResult(t *testing.T) {
	lineage := storesqlite.SessionForkLineage{
		WorkspaceID: "workspace-1", TargetAgentSessionID: "target-1",
		SourceAgentSessionID: "source-1", SourceTurnID: "turn-7",
		TargetTurnID: "target-turn-7",
		OperationID:  "operation-1", ForkedAtUnixMS: 200,
	}
	forkStore := &serviceSessionForkOperationStore{
		operation: storesqlite.SessionForkOperation{
			OperationID: "operation-1", WorkspaceID: "workspace-1",
			RequestID: "request-1", SourceAgentSessionID: "source-1",
			TargetAgentSessionID: "target-1", SourceTurnID: "turn-7",
			TargetTurnID: "target-turn-7",
			Status:       storesqlite.SessionForkStatusCommitted,
		},
		lineage: lineage,
		session: storesqlite.Session{
			ID: "target-1", WorkspaceID: "workspace-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "provider-target", RailSectionKey: "conversations",
			CreatedAtUnixMS: 100, UpdatedAtUnixMS: 200,
		},
		hideCanonicalLineage: true,
	}
	service := &Service{}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		CanonicalStore: &serviceSessionForkCanonicalStore{},
		SessionForks:   forkStore,
	}))

	operation, err := service.AcknowledgeSessionForkOperation(
		t.Context(),
		"workspace-1",
		"operation-1",
	)
	if err != nil {
		t.Fatalf("AcknowledgeSessionForkOperation() error=%v", err)
	}
	if forkStore.acknowledgeCalls != 1 ||
		operation.Status != SessionForkOperationCommitted ||
		operation.Session == nil ||
		operation.Session.ID != "target-1" ||
		operation.Session.ForkedFrom == nil ||
		operation.Session.ForkedFrom.OperationID != "operation-1" ||
		operation.Session.ForkedFrom.TargetTurnID != "target-turn-7" ||
		operation.Lineage == nil ||
		operation.Lineage.SourceTurnID != "turn-7" ||
		operation.Lineage.TargetTurnID != "target-turn-7" {
		t.Fatalf(
			"AcknowledgeSessionForkOperation() calls=%d operation=%#v",
			forkStore.acknowledgeCalls,
			operation,
		)
	}
}

func TestGetSessionForkOperationRejectsInconsistentImmutableCommittedIdentity(t *testing.T) {
	lineage := storesqlite.SessionForkLineage{
		WorkspaceID: "workspace-1", TargetAgentSessionID: "different-target",
		SourceAgentSessionID: "source-1", SourceTurnID: "turn-7",
		OperationID: "operation-1", ForkedAtUnixMS: 200,
	}
	forkStore := &serviceSessionForkOperationStore{
		operation: storesqlite.SessionForkOperation{
			OperationID: "operation-1", WorkspaceID: "workspace-1",
			RequestID: "request-1", SourceAgentSessionID: "source-1",
			TargetAgentSessionID: "target-1", SourceTurnID: "turn-7",
			Status: storesqlite.SessionForkStatusCommitted,
		},
		lineage: lineage,
		session: storesqlite.Session{
			ID: "target-1", WorkspaceID: "workspace-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "provider-target", RailSectionKey: "conversations",
			CreatedAtUnixMS: 100, UpdatedAtUnixMS: 200,
		},
		hideCanonicalLineage: true,
	}
	service := &Service{}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		CanonicalStore: &serviceSessionForkCanonicalStore{},
		SessionForks:   forkStore,
	}))

	_, err := service.GetSessionForkOperation(
		t.Context(),
		"workspace-1",
		"operation-1",
	)
	if !errors.Is(err, ErrSessionForkConflict) {
		t.Fatalf("GetSessionForkOperation() error=%v, want fork conflict", err)
	}
}

func TestGetSessionForkOperationReportsNotFound(t *testing.T) {
	service := &Service{}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionForks: &serviceSessionForkOperationStore{},
	}))
	_, err := service.GetSessionForkOperation(
		t.Context(),
		"workspace-1",
		"missing",
	)
	if !errors.Is(err, ErrSessionForkOperationNotFound) {
		t.Fatalf("GetSessionForkOperation() error=%v", err)
	}
}

type serviceSessionForkOperationRuntime struct {
	disposition agenthost.SessionForkDeliveryDisposition
	forkErr     error
}

func (*serviceSessionForkOperationRuntime) ResolveSessionFork(
	context.Context,
	agenthost.ProviderRuntimeSession,
) (agenthost.SessionForkDriverDescriptor, error) {
	return agenthost.SessionForkDriverDescriptor{
		Kind: "native", Version: "v1", ThroughTurn: true,
		StateBindingMode: agenthost.SessionForkStateBindingProviderOwned,
	}, nil
}

func (r *serviceSessionForkOperationRuntime) ForkSession(
	context.Context,
	agenthost.RuntimeSessionForkInput,
) (agenthost.RuntimeSessionForkResult, error) {
	return agenthost.RuntimeSessionForkResult{
		DeliveryDisposition: r.disposition,
	}, r.forkErr
}

type serviceSessionForkOperationStore struct {
	agenthost.SessionForkStore
	operation            storesqlite.SessionForkOperation
	lineage              storesqlite.SessionForkLineage
	session              storesqlite.Session
	hideCanonicalLineage bool
	acknowledgeCalls     int
}

func (*serviceSessionForkOperationStore) GetSessionForkSource(
	_ context.Context,
	workspaceID, sourceSessionID string,
) (storesqlite.Session, bool, error) {
	return storesqlite.Session{
		ID: sourceSessionID, WorkspaceID: workspaceID,
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
		ProviderSessionID: "provider-source",
	}, true, nil
}

func (*serviceSessionForkOperationStore) CheckSessionForkThroughTurn(
	_ context.Context,
	workspaceID, sourceSessionID, throughTurnID string,
) (storesqlite.SessionForkBoundary, bool, error) {
	return storesqlite.SessionForkBoundary{
		Session: storesqlite.Session{
			ID: sourceSessionID, WorkspaceID: workspaceID,
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "provider-source",
		},
		Turn: storesqlite.Turn{
			TurnID: throughTurnID, Phase: storesqlite.TurnPhaseSettled,
			RootProviderTurnID: "provider-turn",
		},
	}, true, nil
}

func (s *serviceSessionForkOperationStore) PrepareSessionFork(
	_ context.Context,
	input storesqlite.SessionForkPrepare,
) (storesqlite.SessionForkOperation, bool, error) {
	s.operation = storesqlite.SessionForkOperation{
		OperationID: input.OperationID, WorkspaceID: input.WorkspaceID,
		RequestID: input.RequestID, RequestHash: input.RequestHash,
		SourceAgentSessionID:    input.SourceAgentSessionID,
		TargetAgentSessionID:    input.TargetAgentSessionID,
		SourceProviderSessionID: "provider-source",
		SourceTurnID:            input.SourceTurnID, SourceProviderTurnID: "provider-turn",
		DriverKind: input.DriverKind, DriverVersion: input.DriverVersion,
		Status: storesqlite.SessionForkStatusPrepared,
	}
	return s.operation, true, nil
}

func (s *serviceSessionForkOperationStore) GetSessionForkOperation(
	_ context.Context,
	workspaceID, operationID string,
) (storesqlite.SessionForkOperation, bool, error) {
	found := s.operation.OperationID == operationID &&
		s.operation.WorkspaceID == workspaceID
	return s.operation, found, nil
}

func (s *serviceSessionForkOperationStore) GetSessionForkOperationByRequest(
	_ context.Context,
	workspaceID, requestID string,
) (storesqlite.SessionForkOperation, bool, error) {
	found := s.operation.WorkspaceID == workspaceID &&
		s.operation.RequestID == requestID &&
		s.operation.OperationID != ""
	return s.operation, found, nil
}

func (s *serviceSessionForkOperationStore) MarkSessionForkDispatching(
	context.Context,
	string,
	string,
	int64,
) (storesqlite.SessionForkOperation, bool, error) {
	s.operation.Status = storesqlite.SessionForkStatusDispatching
	return s.operation, true, nil
}

func (s *serviceSessionForkOperationStore) GetUnknownSessionForkOperation(
	_ context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	found := s.operation.Status == storesqlite.SessionForkStatusUnknown &&
		s.operation.WorkspaceID == workspaceID &&
		s.operation.SourceAgentSessionID == sourceSessionID &&
		pointKind == storesqlite.SessionForkPointThroughTurn &&
		s.operation.SourceTurnID == sourceTurnID
	return s.operation, found, nil
}

func (s *serviceSessionForkOperationStore) GetBlockingSessionForkOperation(
	_ context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	blockingStatus := s.operation.Status == storesqlite.SessionForkStatusPrepared ||
		s.operation.Status == storesqlite.SessionForkStatusDispatching ||
		s.operation.Status == storesqlite.SessionForkStatusProviderAccepted ||
		s.operation.Status == storesqlite.SessionForkStatusUnknown ||
		(s.operation.Status == storesqlite.SessionForkStatusCommitted &&
			s.operation.ClientObservedAtUnixMS == 0)
	found := blockingStatus &&
		s.operation.WorkspaceID == workspaceID &&
		s.operation.SourceAgentSessionID == sourceSessionID &&
		pointKind == storesqlite.SessionForkPointThroughTurn &&
		s.operation.SourceTurnID == sourceTurnID
	return s.operation, found, nil
}

func (s *serviceSessionForkOperationStore) RecordSessionForkProviderResult(
	_ context.Context,
	input storesqlite.SessionForkProviderResult,
) (storesqlite.SessionForkOperation, bool, error) {
	s.operation.Status = input.Status
	s.operation.LastError = input.LastError
	s.operation.TargetProviderSessionID = input.TargetProviderSessionID
	return s.operation, true, nil
}

func (s *serviceSessionForkOperationStore) CommitSessionFork(
	context.Context,
	string,
	string,
	int64,
) (storesqlite.SessionForkCommitResult, error) {
	return storesqlite.SessionForkCommitResult{
		Operation: s.operation,
		Session:   s.session,
		Lineage:   s.lineage,
	}, nil
}

func (s *serviceSessionForkOperationStore) AcknowledgeSessionForkOperation(
	_ context.Context,
	workspaceID, operationID string,
	_ int64,
) (storesqlite.SessionForkOperation, bool, bool, error) {
	s.acknowledgeCalls++
	found := s.operation.WorkspaceID == workspaceID &&
		s.operation.OperationID == operationID
	if !found {
		return storesqlite.SessionForkOperation{}, false, false, nil
	}
	if s.operation.Status != storesqlite.SessionForkStatusCommitted {
		return s.operation, true, false, storesqlite.ErrSessionForkTransition
	}
	return s.operation, true, s.acknowledgeCalls == 1, nil
}

func (s *serviceSessionForkOperationStore) GetSessionForkLineage(
	_ context.Context,
	workspaceID, targetSessionID string,
) (storesqlite.SessionForkLineage, bool, error) {
	if s.hideCanonicalLineage {
		return storesqlite.SessionForkLineage{}, false, nil
	}
	found := s.lineage.OperationID != "" &&
		s.lineage.WorkspaceID == workspaceID &&
		s.lineage.TargetAgentSessionID == targetSessionID
	return s.lineage, found, nil
}

type serviceSessionForkCanonicalStore struct {
	agenthost.CanonicalStore
	session storesqlite.Session
}

func (s *serviceSessionForkCanonicalStore) GetSession(
	_ context.Context,
	workspaceID, sessionID string,
) (storesqlite.Session, bool, error) {
	found := s.session.WorkspaceID == workspaceID && s.session.ID == sessionID
	return s.session, found, nil
}
