package agent

import (
	"context"
	"errors"
	"strings"
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
	source           agenthost.ProviderRuntimeSession
	calls            int
	forkabilityCalls int
	forkable         bool
	forkabilityErr   error
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

func (r *sessionForkCapabilityRuntime) CanForkProviderTurn(
	_ context.Context,
	input agenthost.RuntimeProviderTurnForkabilityInput,
) (bool, error) {
	r.forkabilityCalls++
	r.source = input.Source
	return r.forkable, r.forkabilityErr
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
	source       storesqlite.Session
}

func (s *sessionForkListProjectionStore) GetSessionForkSource(
	_ context.Context,
	_, _ string,
) (storesqlite.Session, bool, error) {
	s.sourceReads++
	return s.source, strings.TrimSpace(s.source.ID) != "", nil
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

func TestProtocolV2BatchProjectionCachesProviderTurnForkability(t *testing.T) {
	store := &sessionForkListProjectionStore{source: storesqlite.Session{
		ID: "source-1", WorkspaceID: "workspace-1",
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
		ProviderSessionID: "provider-session-1",
	}}
	runtime := &sessionForkCapabilityRuntime{forkable: true}
	turn := storesqlite.Turn{
		AgentSessionID:          "source-1",
		TurnID:                  "turn-7",
		Phase:                   storesqlite.TurnPhaseSettled,
		RootProviderTurnID:      "provider-turn-7",
		ProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
	}
	service := &Service{TurnStore: failingTurnStore{
		latestTurn: turn,
		turn:       turn,
	}}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionForks: store, SessionForkRuntime: runtime,
	}))

	projected, err := service.withProtocolV2TurnStates(
		t.Context(),
		"workspace-1",
		[]Session{{
			ID: "source-1", Kind: storesqlite.SessionKindRoot,
			ActiveTurnID: "turn-7",
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(projected) != 1 || projected[0].LatestTurn == nil ||
		projected[0].ActiveTurn == nil {
		t.Fatalf("projected sessions=%#v, want active and latest Turn", projected)
	}
	if !projected[0].LatestTurn.ProviderForkBindingAvailable ||
		!projected[0].ActiveTurn.ProviderForkBindingAvailable {
		t.Fatalf("projected session=%#v, want bound active/latest Turn", projected[0])
	}
	if runtime.forkabilityCalls != 1 {
		t.Fatalf(
			"provider forkability calls=%d, want one request-cached probe",
			runtime.forkabilityCalls,
		)
	}
	if store.sourceReads != 1 {
		t.Fatalf("source reads=%d, want one request-cached read", store.sourceReads)
	}
}

func TestProtocolV2BatchProjectionForkabilityIsTurnScopedAndFailClosed(t *testing.T) {
	newService := func(runtime *sessionForkCapabilityRuntime) (*Service, *sessionForkListProjectionStore) {
		store := &sessionForkListProjectionStore{source: storesqlite.Session{
			ID: "source-1", WorkspaceID: "workspace-1",
			Kind: storesqlite.SessionKindRoot, Provider: "codex",
			ProviderSessionID: "provider-session-1",
		}}
		service := &Service{TurnStore: failingTurnStore{
			latestTurn: storesqlite.Turn{
				AgentSessionID: "source-1", TurnID: "turn-latest",
				Phase:                   storesqlite.TurnPhaseSettled,
				RootProviderTurnID:      "provider-turn-latest",
				ProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
			},
			turn: storesqlite.Turn{
				AgentSessionID: "source-1", TurnID: "turn-active",
				Phase:                   storesqlite.TurnPhaseSettled,
				RootProviderTurnID:      "provider-turn-active",
				ProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
			},
		}}
		service.SetApplicationHost(agenthost.New(agenthost.Config{
			SessionForks: store, SessionForkRuntime: runtime,
		}))
		return service, store
	}

	t.Run("distinct Turns use distinct cache entries", func(t *testing.T) {
		runtime := &sessionForkCapabilityRuntime{forkable: true}
		service, store := newService(runtime)
		projected, err := service.withProtocolV2TurnStates(
			t.Context(), "workspace-1", []Session{{
				ID: "source-1", Kind: storesqlite.SessionKindRoot,
				ActiveTurnID: "turn-active",
			}},
		)
		if err != nil {
			t.Fatal(err)
		}
		if runtime.forkabilityCalls != 2 || store.sourceReads != 2 {
			t.Fatalf(
				"forkability calls=%d source reads=%d, want 2/2 for distinct Turns",
				runtime.forkabilityCalls, store.sourceReads,
			)
		}
		if !projected[0].LatestTurn.ProviderForkBindingAvailable ||
			!projected[0].ActiveTurn.ProviderForkBindingAvailable {
			t.Fatalf("projected session=%#v, want both Turns bound", projected[0])
		}
	})

	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "provider rejects binding"},
		{name: "provider probe fails", err: errors.New("probe unavailable")},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime := &sessionForkCapabilityRuntime{forkabilityErr: test.err}
			service, _ := newService(runtime)
			projected, err := service.withProtocolV2TurnStates(
				t.Context(), "workspace-1", []Session{{
					ID: "source-1", Kind: storesqlite.SessionKindRoot,
					ActiveTurnID: "turn-active",
				}},
			)
			if err != nil {
				t.Fatal(err)
			}
			if projected[0].LatestTurn.ProviderForkBindingAvailable ||
				projected[0].ActiveTurn.ProviderForkBindingAvailable {
				t.Fatalf("projected session=%#v, want fail-closed Turns", projected[0])
			}
		})
	}
}

func TestListPageProjectsLatestTurnForkability(t *testing.T) {
	store := &sessionForkListProjectionStore{source: storesqlite.Session{
		ID: "source-1", WorkspaceID: "workspace-1",
		Kind: storesqlite.SessionKindRoot, Provider: "codex",
		ProviderSessionID: "provider-session-1",
	}}
	runtime := &sessionForkCapabilityRuntime{forkable: true}
	turn := storesqlite.Turn{
		AgentSessionID: "source-1", TurnID: "turn-7",
		Phase:                   storesqlite.TurnPhaseSettled,
		RootProviderTurnID:      "provider-turn-7",
		ProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
	}
	service := newUnconfiguredIsolatedAgentService(newFakeRuntime())
	service.SessionReader = &recordingSessionPageReader{
		pages: map[string]PersistedSessionListPage{"": {
			Sessions: []PersistedSession{{
				ID: "source-1", WorkspaceID: "workspace-1",
				Kind: storesqlite.SessionKindRoot, Provider: "codex",
				ProviderSessionID: "provider-session-1",
				RailSectionKey:    "conversations",
				Metadata:          storesqlite.SessionMetadata{Visible: true},
			}},
		}},
	}
	service.TurnStore = failingTurnStore{latestTurn: turn}
	service.SetApplicationHost(agenthost.New(agenthost.Config{
		SessionForks: store, SessionForkRuntime: runtime,
	}))

	page, err := service.ListPage(
		t.Context(), "workspace-1", ListSessionsInput{Limit: 100},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Sessions) != 1 || page.Sessions[0].LatestTurn == nil ||
		!page.Sessions[0].LatestTurn.ProviderForkBindingAvailable {
		t.Fatalf("page=%#v, want bound latest Turn", page)
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

func TestSessionForkContextPolicyPreservesWorktreeRuntimeFacts(t *testing.T) {
	policy := serviceHostSessionForkContextPolicy{}
	target, err := policy.PrepareSessionForkTargetContext(t.Context(), storesqlite.Session{
		Cwd: "/tmp/source-worktree",
		InternalRuntimeContext: map[string]any{
			worktreeIsolationContextKey: map[string]any{
				"mode": "worktree", "worktreeId": "worktree-1",
			},
		},
	}, agenthost.ProviderRuntimeSession{
		Cwd: "/tmp/source-worktree",
		RuntimeContext: map[string]any{
			worktreeIsolationContextKey: map[string]any{
				"mode": "worktree", "worktreeId": "worktree-1",
			},
		},
	})
	if err != nil || target.Cwd != "/tmp/source-worktree" {
		t.Fatalf("PrepareSessionForkTargetContext() target=%#v error=%v", target, err)
	}
	isolation, ok := target.RuntimeContext[worktreeIsolationContextKey].(map[string]any)
	if !ok || isolation["worktreeId"] != "worktree-1" {
		t.Fatalf("target runtime context=%#v", target.RuntimeContext)
	}
}

func TestSessionForkContextPolicyPreservesNonOwnedRuntimeFacts(t *testing.T) {
	policy := serviceHostSessionForkContextPolicy{}
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
	target, err := (serviceHostSessionForkContextPolicy{}).PrepareSessionForkTargetContext(t.Context(), source, prepared)
	if err != nil || target.Cwd != "/prepared-project" {
		t.Fatalf("policy without provider state binder target=%#v error=%v", target, err)
	}

	target, err = (serviceHostSessionForkContextPolicy{}).PrepareSessionForkTargetContext(t.Context(), source, prepared)
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

func (*serviceSessionForkOperationRuntime) CanForkProviderTurn(
	context.Context,
	agenthost.RuntimeProviderTurnForkabilityInput,
) (bool, error) {
	return true, nil
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
			RootProviderTurnID:      "provider-turn",
			ProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
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
		SourceProviderTurnBindingJSON: []byte(`{"schemaVersion":1}`),
		DriverKind:                    input.DriverKind, DriverVersion: input.DriverVersion,
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
