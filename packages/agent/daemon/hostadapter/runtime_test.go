package hostadapter

import (
	"context"
	"errors"
	"fmt"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type stateRuntimeBackend struct {
	RuntimeBackend
	session  agentruntime.Session
	state    agentruntime.SessionStateSnapshot
	stateErr error
}

type provenanceRuntimeBackend struct {
	RuntimeBackend
	input agentruntime.SubmitProvenanceInput
	err   error
}

type goalLifecycleRuntimeBackend struct {
	RuntimeBackend
	observer agentruntime.GoalControlLifecycleObserver
}

type closeRuntimeBackend struct {
	RuntimeBackend
	input agentruntime.CloseInput
}

type workspaceDisconnectBackend struct {
	RuntimeBackend
	sessions  []agentruntime.Session
	roomID    string
	sessionID string
	target    agentruntime.RuntimeDisconnectTarget
}

func (*workspaceDisconnectBackend) SnapshotRuntimeDisconnectTargets(string) []agentruntime.RuntimeDisconnectTarget {
	return []agentruntime.RuntimeDisconnectTarget{{
		RoomID: "workspace-1", AgentSessionID: "session-1", ConnectionGeneration: 7,
	}}
}

func (b *workspaceDisconnectBackend) DisconnectRuntimeSessionTarget(
	_ context.Context,
	target agentruntime.RuntimeDisconnectTarget,
) (agentruntime.DisconnectRuntimeSessionResult, error) {
	b.target = target
	return agentruntime.DisconnectRuntimeSessionResult{Disconnected: true}, nil
}

func (b *workspaceDisconnectBackend) RuntimeSessions(context.Context, string) ([]agentruntime.Session, error) {
	return append([]agentruntime.Session(nil), b.sessions...), nil
}

func (*workspaceDisconnectBackend) State(_, _ string) (agentruntime.SessionStateSnapshot, error) {
	return agentruntime.SessionStateSnapshot{}, nil
}

func (b *workspaceDisconnectBackend) DisconnectRuntimeSession(
	_ context.Context,
	roomID string,
	sessionID string,
) (agentruntime.DisconnectRuntimeSessionResult, error) {
	b.roomID = roomID
	b.sessionID = sessionID
	return agentruntime.DisconnectRuntimeSessionResult{Disconnected: true}, nil
}

func TestRuntimeControllerBridgesWorkspaceRuntimeDisconnect(t *testing.T) {
	t.Parallel()
	backend := &workspaceDisconnectBackend{sessions: []agentruntime.Session{{
		RoomID: "workspace-1", AgentSessionID: "session-1", ProviderSessionID: "provider-1",
	}}}
	controller := &RuntimeController{Backend: backend}
	sessions, err := controller.WorkspaceRuntimeSessions(t.Context(), " workspace-1 ")
	if err != nil {
		t.Fatalf("WorkspaceRuntimeSessions: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "session-1" || sessions[0].ProviderSessionID != "provider-1" {
		t.Fatalf("sessions=%#v", sessions)
	}
	disconnected, err := controller.DisconnectRuntimeSession(t.Context(), host.SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	})
	if err != nil || !disconnected {
		t.Fatalf("disconnected=%v err=%v", disconnected, err)
	}
	if backend.roomID != "workspace-1" || backend.sessionID != "session-1" {
		t.Fatalf("backend ref=%q/%q", backend.roomID, backend.sessionID)
	}
	targets := controller.SnapshotWorkspaceRuntimeDisconnectTargets("workspace-1")
	if len(targets) != 1 || targets[0].ConnectionGeneration != 7 {
		t.Fatalf("targets=%#v", targets)
	}
	disconnected, err = controller.DisconnectRuntimeSessionTarget(t.Context(), targets[0])
	if err != nil || !disconnected || backend.target.ConnectionGeneration != 7 {
		t.Fatalf("target disconnect=%v err=%v backend=%#v", disconnected, err, backend.target)
	}
}

func (b *closeRuntimeBackend) Close(_ context.Context, input agentruntime.CloseInput) (agentruntime.CloseResult, error) {
	b.input = input
	return agentruntime.CloseResult{AgentSessionID: input.AgentSessionID, Disconnected: true}, nil
}

func TestRuntimeControllerPreservesCanonicalStateWhenClosingRuntime(t *testing.T) {
	t.Parallel()
	backend := &closeRuntimeBackend{}
	controller := &RuntimeController{Backend: backend}

	if err := controller.Close(t.Context(), host.RuntimeCloseInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-rejected", PreserveCanonicalState: true,
	}); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if backend.input.RoomID != "workspace-1" ||
		backend.input.AgentSessionID != "session-rejected" ||
		!backend.input.PreserveCanonicalState {
		t.Fatalf("backend close input = %#v", backend.input)
	}
}

func TestRuntimeResumeInputMapsDurableGoalGenerationFences(t *testing.T) {
	t.Parallel()
	mapped := runtimeResumeInput(host.RuntimeResumeInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex",
		GoalGenerationFences: []host.RuntimeGoalGenerationFenceInput{{
			TargetOperationID: "old-goal", TargetRevision: 3, TargetRepairEpoch: 2,
			Reason: "binding_revoked", RequireLive: false,
		}},
	})
	if len(mapped.GoalGenerationFences) != 1 {
		t.Fatalf("mapped fences=%#v", mapped.GoalGenerationFences)
	}
	fence := mapped.GoalGenerationFences[0]
	if fence.OperationID != "old-goal" || fence.Revision != 3 || fence.RepairEpoch != 2 ||
		fence.Reason != "binding_revoked" {
		t.Fatalf("mapped fence=%#v", fence)
	}
}

func (b *goalLifecycleRuntimeBackend) SetGoalControlLifecycleObserver(observer agentruntime.GoalControlLifecycleObserver) {
	b.observer = observer
}

func TestRuntimeControllerBridgesGoalLifecycleToHostSink(t *testing.T) {
	t.Parallel()
	backend := &goalLifecycleRuntimeBackend{}
	controller := &RuntimeController{Backend: backend}
	var received host.RuntimeGoalControlAppliedInput
	controller.SetGoalControlAppliedSink(func(_ context.Context, input host.RuntimeGoalControlAppliedInput) error {
		received = input
		return nil
	})
	if backend.observer == nil {
		t.Fatal("goal lifecycle observer was not registered")
	}
	err := backend.observer.ObserveGoalControlApplied(t.Context(), agentruntime.GoalControlAppliedObservation{
		WorkspaceID: "workspace", AgentSessionID: "session", OperationID: "goal-op-1",
		Revision: 3, RepairEpoch: 1, Action: "set", ProviderTurnID: "provider-turn-1",
		Observed: map[string]any{"objective": "ship it", "status": "active"}, OccurredAtUnixMS: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if received.WorkspaceID != "workspace" || received.AgentSessionID != "session" ||
		received.OperationID != "goal-op-1" || received.GoalRevision != 3 || received.RepairEpoch != 1 ||
		received.Action != "set" || received.ProviderTurnID != "provider-turn-1" ||
		received.Observed["objective"] != "ship it" || received.OccurredAtUnixMS != 42 {
		t.Fatalf("host goal lifecycle input=%#v", received)
	}
}

func (b *provenanceRuntimeBackend) DurablyReportSubmitProvenance(_ context.Context, input agentruntime.SubmitProvenanceInput) error {
	b.input = input
	return b.err
}

func (b *stateRuntimeBackend) Session(_, _ string) (agentruntime.Session, bool) {
	return b.session, true
}

func (b *stateRuntimeBackend) State(_, _ string) (agentruntime.SessionStateSnapshot, error) {
	return b.state, b.stateErr
}

func TestMapRuntimeErrorPreservesProviderDiagnostics(t *testing.T) {
	cause := errors.New("provider process rejected request")
	runtimeErr := &agentruntime.AppError{
		Code:         "provider_auth_required",
		Message:      "Agent provider needs authentication",
		DebugMessage: "provider exited with status 1",
		Cause:        cause,
	}

	mapped := mapRuntimeError(fmt.Errorf("daemon runtime: %w", runtimeErr))
	var providerErr *host.ProviderError
	if !errors.As(mapped, &providerErr) {
		t.Fatalf("mapped error = %v, want ProviderError", mapped)
	}
	if providerErr.Code != runtimeErr.Code || providerErr.Message != runtimeErr.Message || providerErr.DebugMessage != runtimeErr.DebugMessage {
		t.Fatalf("ProviderError = %#v, want diagnostics from %#v", providerErr, runtimeErr)
	}
	if !errors.Is(mapped, runtimeErr) || !errors.Is(mapped, cause) {
		t.Fatalf("mapped error did not preserve source chain: %v", mapped)
	}
}

func TestMapRuntimeErrorKeepsTransportOutcomeUnknown(t *testing.T) {
	for _, target := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(target.Error(), func(t *testing.T) {
			runtimeErr := &agentruntime.AppError{
				Code:  "request_failed",
				Cause: fmt.Errorf("provider response: %w", target),
			}
			mapped := mapRuntimeError(runtimeErr)
			var providerErr *host.ProviderError
			if errors.As(mapped, &providerErr) {
				t.Fatalf("mapped error = %#v, want transport outcome to remain unknown", providerErr)
			}
			if !errors.Is(mapped, target) {
				t.Fatalf("mapped error = %v, want %v in chain", mapped, target)
			}
		})
	}
}

func TestMapRuntimeErrorMapsDisconnectedSessionAcrossHostBoundary(t *testing.T) {
	runtimeErr := fmt.Errorf("fence requires live provider: %w", agentruntime.ErrSessionDisconnected)
	mapped := mapRuntimeError(runtimeErr)
	if !errors.Is(mapped, host.ErrRuntimeSessionDisconnected) {
		t.Fatalf("mapped error = %v, want Host disconnected sentinel", mapped)
	}
	if !errors.Is(mapped, agentruntime.ErrSessionDisconnected) {
		t.Fatalf("mapped error = %v, want source runtime sentinel preserved", mapped)
	}
}

func TestMapRuntimeErrorMapsMissingSessionAcrossHostBoundary(t *testing.T) {
	runtimeErr := fmt.Errorf("fence session disappeared: %w", agentruntime.ErrSessionNotFound)
	mapped := mapRuntimeError(runtimeErr)
	if !errors.Is(mapped, host.ErrSessionNotFound) {
		t.Fatalf("mapped error = %v, want Host missing-session sentinel", mapped)
	}
	if !errors.Is(mapped, agentruntime.ErrSessionNotFound) {
		t.Fatalf("mapped error = %v, want source runtime sentinel preserved", mapped)
	}
}

func TestMapRuntimeErrorMapsGuidanceTargetVerdictsAcrossHostBoundary(t *testing.T) {
	for _, testCase := range []struct {
		runtimeErr error
		hostErr    error
	}{
		{agentruntime.ErrActiveTurnTargetRequired, host.ErrActiveTurnTargetRequired},
		{agentruntime.ErrActiveTurnTargetMismatch, host.ErrActiveTurnTargetMismatch},
	} {
		t.Run(testCase.runtimeErr.Error(), func(t *testing.T) {
			mapped := mapRuntimeError(fmt.Errorf("guidance dispatch: %w", testCase.runtimeErr))
			if !errors.Is(mapped, testCase.hostErr) {
				t.Fatalf("mapped error = %v, want Host sentinel %v", mapped, testCase.hostErr)
			}
			if !errors.Is(mapped, testCase.runtimeErr) {
				t.Fatalf("mapped error = %v, want source runtime sentinel preserved", mapped)
			}
		})
	}
}

func TestRuntimeControllerProjectsSessionWithoutAliasingMutableInputs(t *testing.T) {
	runtimeContext := map[string]any{"mode": "plan"}
	providerTargetRef := map[string]any{"agent": "codex"}
	env := []string{"A=1"}
	controller := &RuntimeController{CurrentUserID: func() string { return " user-1 " }}

	projected := controller.fromSession(agentruntime.Session{
		RoomID: "workspace-1", AgentSessionID: "session-1", AgentTargetID: "target-1",
		Provider: "codex", Env: env, RuntimeContext: runtimeContext,
		ProviderTargetRef: providerTargetRef,
		Settings:          &agentruntime.SessionSettings{Model: "gpt-5.6", ReasoningEffort: "max", Speed: "standard"},
	})
	env[0] = "A=2"
	runtimeContext["mode"] = "changed"
	providerTargetRef["agent"] = "changed"

	if projected.UserID != "user-1" || projected.Env[0] != "A=1" ||
		projected.RuntimeContext["mode"] != "plan" ||
		projected.ProviderTargetRef["agent"] != "codex" {
		t.Fatalf("projected session retained mutable input or identity whitespace: %#v", projected)
	}
	if projected.Settings == nil || projected.Settings.Model != "gpt-5.6" || projected.Settings.ReasoningEffort != "max" || projected.Settings.Speed != "standard" {
		t.Fatalf("projected settings = %#v", projected.Settings)
	}
}

func TestRuntimeSessionProjectsPreparedIdentityWithoutAliasing(t *testing.T) {
	env := []string{"FORK_ENV=prepared"}
	runtimeContext := map[string]any{"origin": "prepared"}
	providerTargetRef := map[string]any{"agent": "codex"}
	projected := runtimeSession(host.ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex",
		Cwd: "/prepared", Env: env, RuntimeContext: runtimeContext,
		ProviderTargetRef: providerTargetRef,
		Settings:          &host.ComposerSettings{Model: "gpt-5.6"},
	})
	env[0] = "FORK_ENV=changed"
	runtimeContext["origin"] = "changed"
	providerTargetRef["agent"] = "changed"

	if projected.CWD != "/prepared" || projected.Env[0] != "FORK_ENV=prepared" ||
		projected.RuntimeContext["origin"] != "prepared" ||
		projected.ProviderTargetRef["agent"] != "codex" ||
		projected.Settings == nil || projected.Settings.Model != "gpt-5.6" {
		t.Fatalf("projected prepared identity=%#v", projected)
	}
}

func TestRuntimeControllerProjectsProviderEnrichedLiveState(t *testing.T) {
	backend := &stateRuntimeBackend{
		session: agentruntime.Session{
			RoomID: "workspace-1", AgentSessionID: "session-1", Provider: "codex",
			ProviderSessionID: "base-provider-session", Status: "starting",
			RuntimeContext:  map[string]any{"base": true},
			Settings:        &agentruntime.SessionSettings{Model: "base-model"},
			UpdatedAtUnixMS: 10,
		},
		state: agentruntime.SessionStateSnapshot{
			ProviderSessionID: "live-provider-session",
			Status:            "ready",
			Settings: &agentruntime.SessionSettings{
				Model: "gpt-5.6", ReasoningEffort: "max", Speed: "fast",
			},
			Capabilities: canonical.NewCapabilitySnapshot([]string{canonical.CapabilityGoalPause}),
			RuntimeContext: map[string]any{
				"account":    map[string]any{"email": "agent@example.com"},
				"rateLimits": map[string]any{"primary": 42},
				"usage":      map[string]any{"usedTokens": 1200},
				"commands":   []string{"compact", "status"},
			},
			UpdatedAtUnixMS: 20,
		},
	}
	controller := &RuntimeController{Backend: backend}

	projected, found := controller.Session("workspace-1", "session-1")
	if !found {
		t.Fatal("Session() found = false")
	}
	if projected.ProviderSessionID != "live-provider-session" || projected.Status != "ready" || projected.UpdatedAtUnixMS != 20 {
		t.Fatalf("projected live identity/status = %#v", projected)
	}
	if projected.Settings == nil || projected.Settings.Model != "gpt-5.6" || projected.Settings.ReasoningEffort != "max" || projected.Settings.Speed != "fast" {
		t.Fatalf("projected live settings = %#v", projected.Settings)
	}
	if projected.RuntimeContext["account"] == nil || projected.RuntimeContext["rateLimits"] == nil || projected.RuntimeContext["usage"] == nil || projected.RuntimeContext["commands"] == nil {
		t.Fatalf("projected live runtime context = %#v", projected.RuntimeContext)
	}
	if projected.Capabilities == nil || len(projected.Capabilities.Values) != 1 || projected.Capabilities.Values[0] != canonical.CapabilityGoalPause {
		t.Fatalf("projected live capabilities = %#v", projected.Capabilities)
	}
}

func TestRuntimeControllerFallsBackToBaseSessionWhenLiveStateFails(t *testing.T) {
	backend := &stateRuntimeBackend{
		session: agentruntime.Session{
			RoomID: "workspace-1", AgentSessionID: "session-1", Provider: "codex",
			Status: "starting", RuntimeContext: map[string]any{"base": true},
		},
		stateErr: errors.New("state unavailable"),
	}
	controller := &RuntimeController{Backend: backend}

	projected, found := controller.Session("workspace-1", "session-1")
	if !found || projected.Status != "starting" || projected.RuntimeContext["base"] != true {
		t.Fatalf("Session() = %#v found=%v, want base observation", projected, found)
	}
}

func TestRuntimeControllerFailsClosedWithoutBackend(t *testing.T) {
	controller := &RuntimeController{}
	if _, err := controller.Start(t.Context(), host.RuntimeStartInput{}); err == nil {
		t.Fatal("Start succeeded without a runtime backend")
	}
	if controller.CanResume(host.RuntimeResumeInput{}) {
		t.Fatal("CanResume reported support without a runtime backend")
	}
}

func TestRuntimeControllerDelegatesDurableSubmitProvenance(t *testing.T) {
	backend := &provenanceRuntimeBackend{}
	controller := &RuntimeController{Backend: backend}
	input := host.RuntimeSubmitProvenanceInput{
		WorkspaceID: " workspace-1 ", AgentSessionID: "session-1", TurnID: "turn-1",
		ClientSubmitID: "submit-1", DisplayPrompt: "display", Guidance: true,
		CanonicalSubmitOccurredAtUnixMS: 1_234,
		Content:                         []host.PromptContentBlock{{Type: "text", Text: "hello"}},
	}

	if err := controller.DurablyReportSubmitProvenance(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	if backend.input.RoomID != input.WorkspaceID || backend.input.AgentSessionID != input.AgentSessionID ||
		backend.input.TurnID != input.TurnID || backend.input.ClientSubmitID != input.ClientSubmitID ||
		backend.input.CanonicalSubmitOccurredAtUnixMS != input.CanonicalSubmitOccurredAtUnixMS ||
		backend.input.DisplayPrompt != input.DisplayPrompt || !backend.input.Guidance {
		t.Fatalf("delegated provenance = %#v", backend.input)
	}
	if len(backend.input.Content) != 1 || backend.input.Content[0].Text != "hello" {
		t.Fatalf("delegated content = %#v", backend.input.Content)
	}
}

func TestRuntimeControllerPreservesTypedExecIdentity(t *testing.T) {
	input := host.RuntimeExecInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1", ClientSubmitID: "submit-1",
		CanonicalSubmitOccurredAtUnixMS: 1_234,
		CapabilityRefs:                  []host.CapabilityReference{{Capability: "browser-use", Source: "composer"}},
		TuttiModeSnapshot: &host.TuttiModeTurnSnapshot{
			ActivationID: "activation-1", RevisionID: "revision-1", Revision: 2,
			State: "active", Source: "workspace",
			PreferenceVersion: host.TuttiModePreferenceVersionEffectSpeed,
			Effect:            75, Speed: 60, OrchestrationIntensity: 75,
		},
	}

	projected := runtimeExecInput(input)
	if projected.TurnID != input.TurnID || projected.ClientSubmitID != input.ClientSubmitID ||
		projected.CanonicalSubmitOccurredAtUnixMS != input.CanonicalSubmitOccurredAtUnixMS {
		t.Fatalf("projected exec identity = %#v", projected)
	}
	if len(projected.CapabilityRefs) != 1 || projected.CapabilityRefs[0].Capability != "browser-use" || projected.CapabilityRefs[0].Source != "composer" {
		t.Fatalf("projected capability refs = %#v", projected.CapabilityRefs)
	}
	if projected.TuttiModeSnapshot == nil {
		t.Fatal("projected Tutti Mode snapshot is nil")
	}
	legacyOrchestrationIntensity := projected.TuttiModeSnapshot.OrchestrationIntensity //nolint:staticcheck // Compatibility assertion covers the deprecated alias.
	if projected.TuttiModeSnapshot.ActivationID != "activation-1" ||
		projected.TuttiModeSnapshot.RevisionID != "revision-1" || projected.TuttiModeSnapshot.Revision != 2 ||
		projected.TuttiModeSnapshot.State != "active" || projected.TuttiModeSnapshot.Source != "workspace" ||
		projected.TuttiModeSnapshot.PreferenceVersion != agentruntime.TuttiModePreferenceVersionEffectSpeed ||
		projected.TuttiModeSnapshot.Effect != 75 || projected.TuttiModeSnapshot.Speed != 60 ||
		legacyOrchestrationIntensity != 75 {
		t.Fatalf("projected Tutti Mode snapshot = %#v", projected.TuttiModeSnapshot)
	}
}
