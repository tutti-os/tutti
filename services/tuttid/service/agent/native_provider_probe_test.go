package agent

import (
	"context"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

type completedProbeTurnStore struct {
	*waitRuntime
	completed bool
}

func (s *completedProbeTurnStore) GetLatestTurn(
	_ context.Context,
	workspaceID string,
	sessionID string,
) (agentactivitybiz.Turn, bool, error) {
	if s.completed {
		return completedProbeTurn(workspaceID, sessionID), true, nil
	}
	return activeProbeTurn(workspaceID, sessionID), true, nil
}

func (s *completedProbeTurnStore) GetTurn(
	_ context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
) (agentactivitybiz.Turn, bool, error) {
	if s.completed && turnID == "turn-1" {
		return completedProbeTurn(workspaceID, sessionID), true, nil
	}
	if turnID == "turn-1" {
		return activeProbeTurn(workspaceID, sessionID), true, nil
	}
	return agentactivitybiz.Turn{}, false, nil
}

func (s *completedProbeTurnStore) GetSession(
	_ context.Context,
	workspaceID string,
	sessionID string,
) (agentactivitybiz.Session, bool, error) {
	if s.completed {
		return agentactivitybiz.Session{WorkspaceID: workspaceID, ID: sessionID}, true, nil
	}
	return agentactivitybiz.Session{WorkspaceID: workspaceID, ID: sessionID, ActiveTurnID: "turn-1"}, true, nil
}

func activeProbeTurn(workspaceID string, sessionID string) agentactivitybiz.Turn {
	return agentactivitybiz.Turn{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		TurnID:         "turn-1",
		Phase:          agentactivitybiz.TurnPhaseRunning,
	}
}

func completedProbeTurn(workspaceID string, sessionID string) agentactivitybiz.Turn {
	return agentactivitybiz.Turn{
		WorkspaceID:    workspaceID,
		AgentSessionID: sessionID,
		TurnID:         "turn-1",
		Phase:          agentactivitybiz.TurnPhaseSettled,
		Outcome:        agentactivitybiz.TurnOutcomeCompleted,
	}
}

func TestProbeNativeProviderStopsBeforeRuntimeWhenLoginIsMissing(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	service.AvailabilityChecker = &fakeProviderAvailabilityChecker{result: []ProviderAvailability{{
		Provider: "codex",
		Status:   ProviderAvailabilityUnavailable,
		Checks: []ProviderAvailabilityCheck{
			{Name: "cli", Passed: true},
			{Name: "adapter", Passed: true},
			{Name: "auth", Passed: false, Detail: "authentication required"},
		},
	}}}

	result, err := service.ProbeNativeProvider(context.Background(), NativeProviderProbeInput{
		WorkspaceID:   "ws",
		AgentTargetID: "local:codex",
		Provider:      "codex",
	})
	if err != nil {
		t.Fatalf("ProbeNativeProvider() error = %v", err)
	}
	if result.Availability == nil || result.InferenceAttempted || len(runtime.startCalls) != 0 {
		t.Fatalf("probe result = %#v, start calls = %#v", result, runtime.startCalls)
	}
}

func TestProbeNativeProviderIgnoresPlanBindingAndCleansHiddenSession(t *testing.T) {
	runtime := newWaitRuntime()
	turnStore := &completedProbeTurnStore{waitRuntime: runtime}
	service := newTestService(runtime)
	service.TurnStore = turnStore
	service.MessageReader = &waitMessageReader{}
	service.ModelCatalog = &recordingModelCatalog{}
	service.AvailabilityChecker = &fakeProviderAvailabilityChecker{result: []ProviderAvailability{{
		Provider: "codex",
		Status:   ProviderAvailabilityAvailable,
		Checks: []ProviderAvailabilityCheck{
			{Name: "cli", Passed: true},
			{Name: "adapter", Passed: true},
			{Name: "auth", Passed: true},
		},
	}}}
	overrides := &recordingAutomationRuleOverrideWriter{}
	service.AutomationRuleOverrides = overrides
	service.ConfigureModelPlanBinding(
		staticBindingSource{binding: modelbindingbiz.Binding{ModelPlanID: "bound-plan"}},
		staticPlanSource{plan: modelplanbiz.Plan{
			ID:           "bound-plan",
			WorkspaceID:  "ws",
			Revision:     1,
			Name:         "Bound API",
			Protocol:     modelplanbiz.ProtocolOpenAI,
			APIKey:       "secret",
			BaseURL:      "https://bound.invalid/v1",
			Models:       []modelplanbiz.Model{{ID: "gpt-bound"}},
			DefaultModel: "gpt-bound",
			Enabled:      true,
		}},
		nil,
	)

	probeDone := make(chan NativeProviderProbeResult, 1)
	probeErr := make(chan error, 1)
	go func() {
		result, err := service.ProbeNativeProvider(context.Background(), NativeProviderProbeInput{
			WorkspaceID:   "ws",
			AgentTargetID: "local:codex",
			Provider:      "codex",
			Model:         "gpt-native",
		})
		if err != nil {
			probeErr <- err
			return
		}
		probeDone <- result
	}()

	select {
	case <-runtime.subscribeStarted:
	case err := <-probeErr:
		t.Fatalf("ProbeNativeProvider() error = %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("probe did not reach runtime wait")
	}
	turnStore.completed = true
	runtime.events <- RuntimeStreamEvent{EventType: "state_patch"}
	close(runtime.events)

	select {
	case err := <-probeErr:
		t.Fatalf("ProbeNativeProvider() error = %v", err)
	case result := <-probeDone:
		if !result.InferenceAttempted || !result.InferencePassed || result.InferenceModel != "gpt-native" {
			t.Fatalf("probe result = %#v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("probe did not settle")
	}
	if len(runtime.startCalls) != 1 || runtime.startCalls[0].Model != "gpt-native" || runtime.startCalls[0].Visible == nil || *runtime.startCalls[0].Visible {
		t.Fatalf("start calls = %#v", runtime.startCalls)
	}
	if len(runtime.closeCalls) != 1 {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
	if len(overrides.calls) != 1 || !overrides.calls[0].Disabled {
		t.Fatalf("automation overrides = %#v", overrides.calls)
	}
}

var _ AutomationRuleSessionOverrideWriter = (*recordingAutomationRuleOverrideWriter)(nil)
