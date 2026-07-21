package hostadapter

import (
	"context"
	"errors"
	"fmt"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

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

func TestRuntimeControllerFailsClosedWithoutBackend(t *testing.T) {
	controller := &RuntimeController{}
	if _, err := controller.Start(t.Context(), host.RuntimeStartInput{}); err == nil {
		t.Fatal("Start succeeded without a runtime backend")
	}
	if controller.CanResume(host.RuntimeResumeInput{}) {
		t.Fatal("CanResume reported support without a runtime backend")
	}
}
