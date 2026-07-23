package hostadapter

import (
	"context"
	"errors"
	"fmt"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
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

type execRuntimeBackend struct {
	RuntimeBackend
	input agentruntime.ExecInput
}

func (b *execRuntimeBackend) Exec(_ context.Context, input agentruntime.ExecInput) (agentruntime.ExecResult, error) {
	b.input = input
	return agentruntime.ExecResult{AgentSessionID: input.AgentSessionID, TurnID: input.TurnID, Accepted: true}, nil
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

func TestRuntimeControllerProjectsSessionWithoutAliasingMutableInputs(t *testing.T) {
	runtimeContext := map[string]any{"mode": "plan"}
	env := []string{"A=1"}
	controller := &RuntimeController{CurrentUserID: func() string { return " user-1 " }}

	projected := controller.fromSession(agentruntime.Session{
		RoomID: "workspace-1", AgentSessionID: "session-1", AgentTargetID: "target-1",
		Provider: "codex", Env: env, RuntimeContext: runtimeContext,
		Settings: &agentruntime.SessionSettings{Model: "gpt-5.6", ReasoningEffort: "max", Speed: "standard"},
	})
	env[0] = "A=2"
	runtimeContext["mode"] = "changed"

	if projected.UserID != "user-1" || projected.Env[0] != "A=1" || projected.RuntimeContext["mode"] != "plan" {
		t.Fatalf("projected session retained mutable input or identity whitespace: %#v", projected)
	}
	if projected.Settings == nil || projected.Settings.Model != "gpt-5.6" || projected.Settings.ReasoningEffort != "max" || projected.Settings.Speed != "standard" {
		t.Fatalf("projected settings = %#v", projected.Settings)
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
		Content: []host.PromptContentBlock{{Type: "text", Text: "hello"}},
	}

	if err := controller.DurablyReportSubmitProvenance(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	if backend.input.RoomID != input.WorkspaceID || backend.input.AgentSessionID != input.AgentSessionID ||
		backend.input.TurnID != input.TurnID || backend.input.ClientSubmitID != input.ClientSubmitID ||
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
		CapabilityRefs: []host.CapabilityReference{{Capability: "browser-use", Source: "composer"}},
		TuttiModeSnapshot: &host.TuttiModeTurnSnapshot{
			ActivationID: "activation-1", RevisionID: "revision-1", Revision: 2,
			State: "active", Source: "workspace", OrchestrationIntensity: 75,
		},
	}

	projected := runtimeExecInput(input)
	if projected.TurnID != input.TurnID || projected.ClientSubmitID != input.ClientSubmitID {
		t.Fatalf("projected exec identity = %#v", projected)
	}
	if len(projected.CapabilityRefs) != 1 || projected.CapabilityRefs[0].Capability != "browser-use" || projected.CapabilityRefs[0].Source != "composer" {
		t.Fatalf("projected capability refs = %#v", projected.CapabilityRefs)
	}
	if projected.TuttiModeSnapshot == nil || projected.TuttiModeSnapshot.ActivationID != "activation-1" ||
		projected.TuttiModeSnapshot.RevisionID != "revision-1" || projected.TuttiModeSnapshot.Revision != 2 ||
		projected.TuttiModeSnapshot.State != "active" || projected.TuttiModeSnapshot.Source != "workspace" ||
		projected.TuttiModeSnapshot.OrchestrationIntensity != 75 {
		t.Fatalf("projected Tutti Mode snapshot = %#v", projected.TuttiModeSnapshot)
	}
}

func TestRuntimeExecInputMapsTurnLineage(t *testing.T) {
	input := host.RuntimeExecInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-derived",
		TurnLineage: &host.TurnLineage{ParentTurnID: " parent-turn ", Relation: host.TurnRelationRetry},
	}

	projected := runtimeExecInput(input)
	if projected.TurnLineage == nil {
		t.Fatal("projected TurnLineage = nil")
	}
	if projected.TurnLineage.ParentTurnID != "parent-turn" || projected.TurnLineage.Relation != agentruntime.TurnRelationRetry {
		t.Fatalf("projected TurnLineage = %#v", projected.TurnLineage)
	}
}

func TestRuntimeControllerExecDelegatesTurnLineageToProductionBackend(t *testing.T) {
	backend := &execRuntimeBackend{}
	controller := &RuntimeController{Backend: backend}
	_, err := controller.Exec(t.Context(), host.RuntimeExecInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-derived",
		TurnLineage: &host.TurnLineage{ParentTurnID: "parent-turn", Relation: host.TurnRelationRetry},
	})
	if err != nil {
		t.Fatal(err)
	}
	if backend.input.TurnLineage == nil || backend.input.TurnLineage.ParentTurnID != "parent-turn" || backend.input.TurnLineage.Relation != agentruntime.TurnRelationRetry {
		t.Fatalf("production backend exec lineage = %#v", backend.input.TurnLineage)
	}
}

func TestRuntimeExecInputLeavesOrdinarySubmitWithoutLineage(t *testing.T) {
	projected := runtimeExecInput(host.RuntimeExecInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-ordinary",
		Content: []host.PromptContentBlock{{Type: "text", Text: "hello"}},
	})
	if projected.TurnLineage != nil {
		t.Fatalf("ordinary submit lineage = %#v, want nil", projected.TurnLineage)
	}
	if len(projected.Content) != 1 || projected.Content[0].Text != "hello" {
		t.Fatalf("ordinary submit content = %#v", projected.Content)
	}
}
