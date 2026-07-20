package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type unavailableAgentExtensionResumeResolver struct{}

func (unavailableAgentExtensionResumeResolver) ResolveAdapter(context.Context, agentruntime.AdapterResolveInput) (agentruntime.Adapter, error) {
	return nil, errors.New("adapter resolution must not run during resume eligibility checks")
}

type submitProvenanceAdapterTestProvider struct{}

func (submitProvenanceAdapterTestProvider) Provider() string { return "submit-provenance-test" }
func (submitProvenanceAdapterTestProvider) Start(context.Context, agentruntime.Session) ([]activityshared.Event, error) {
	return nil, nil
}
func (submitProvenanceAdapterTestProvider) Resume(context.Context, agentruntime.Session) error {
	return nil
}
func (submitProvenanceAdapterTestProvider) Close(context.Context, agentruntime.Session) error {
	return nil
}
func (submitProvenanceAdapterTestProvider) Exec(context.Context, agentruntime.Session, []agentruntime.PromptContentBlock, string, string, agentruntime.EventSink, agentruntime.CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}
func (submitProvenanceAdapterTestProvider) Cancel(context.Context, agentruntime.Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type submitProvenanceAdapterTestReporter struct {
	provenance agentsessionstore.ReportActivityInput
}

func (*submitProvenanceAdapterTestReporter) Report(context.Context, agentsessionstore.ReportActivityInput) error {
	return nil
}

func (r *submitProvenanceAdapterTestReporter) ReportSubmitProvenance(_ context.Context, input agentsessionstore.ReportActivityInput) error {
	r.provenance = input
	return nil
}

func TestMapAgentRuntimeErrorPreservesInteractiveRecoveryCodes(t *testing.T) {
	tests := []struct {
		runtimeErr error
		serviceErr error
	}{
		{agentruntime.ErrInteractiveRequestNotLive, agentservice.ErrInteractiveRequestNotLive},
		{agentruntime.ErrInteractiveAlreadyAnswered, agentservice.ErrInteractiveAlreadyAnswered},
		{agentruntime.ErrSessionDisconnected, agentservice.ErrRuntimeSessionDisconnected},
	}
	for _, test := range tests {
		if err := mapAgentRuntimeError(test.runtimeErr); !errors.Is(err, test.serviceErr) {
			t.Fatalf("mapAgentRuntimeError(%v) = %v, want %v", test.runtimeErr, err, test.serviceErr)
		}
	}
}

func TestMapAgentRuntimeErrorPreservesStructuredProviderFailure(t *testing.T) {
	cause := errors.New("provider process rejected startup")
	runtimeErr := &agentruntime.AppError{
		Code:         "provider_auth_required",
		Message:      "Agent provider needs authentication",
		DebugMessage: "provider exited with status 1",
		Cause:        cause,
	}

	mapped := mapAgentRuntimeError(fmt.Errorf("runtime start: %w", runtimeErr))
	var providerErr *agenthost.ProviderError
	if !errors.As(mapped, &providerErr) {
		t.Fatalf("mapped error = %v, want ProviderError", mapped)
	}
	if providerErr.Code != runtimeErr.Code || providerErr.Message != runtimeErr.Message || providerErr.DebugMessage != runtimeErr.DebugMessage {
		t.Fatalf("ProviderError = %#v, want diagnostics from %#v", providerErr, runtimeErr)
	}
	if !errors.Is(mapped, cause) || !errors.Is(mapped, runtimeErr) {
		t.Fatalf("mapped error did not preserve runtime error chain: %v", mapped)
	}
}

func TestMapAgentRuntimeErrorDoesNotClassifyProviderTimeoutAsDefinitive(t *testing.T) {
	runtimeErr := &agentruntime.AppError{
		Code:    "request_failed",
		Message: "Agent provider request failed",
		Cause:   fmt.Errorf("provider response: %w", context.DeadlineExceeded),
	}

	mapped := mapAgentRuntimeError(runtimeErr)
	var providerErr *agenthost.ProviderError
	if errors.As(mapped, &providerErr) {
		t.Fatalf("mapped error = %#v, want recoverable timeout", providerErr)
	}
	if !errors.Is(mapped, context.DeadlineExceeded) {
		t.Fatalf("mapped error = %v, want deadline in error chain", mapped)
	}
}

func TestAgentRuntimeAdapterCanResumePreservesExtensionTargetBinding(t *testing.T) {
	controller := agentruntime.NewControllerWithAdapterResolver(nil, nil, unavailableAgentExtensionResumeResolver{})
	adapter := newAgentRuntimeAdapter(controller)

	if !adapter.CanResume(agentservice.RuntimeResumeInput{
		WorkspaceID:       "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "extension:codebuddy",
		Provider:          "acp:codebuddy",
		ProviderSessionID: "provider-session-1",
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"provider":                "acp:codebuddy",
			"targetId":                "extension:codebuddy",
			"extensionInstallationId": "codebuddy@1.0.0",
		},
	}) {
		t.Fatal("CanResume() = false, want authorized extension session to remain resumable across the tuttid runtime adapter")
	}
}

func TestRuntimeCapabilityReferencesFromServicePreservesStructuredProvenance(t *testing.T) {
	got := runtimeCapabilityReferencesFromService([]agentservice.CapabilityReference{{
		Capability: "tutti",
		Source:     "slash_command",
	}})
	if len(got) != 1 || got[0] != (agentruntime.CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
		t.Fatalf("runtime capability refs = %#v", got)
	}
}

func TestRuntimeTuttiModeSnapshotFromServicePreservesTypedRevision(t *testing.T) {
	source := &agentservice.TuttiModeTurnSnapshot{
		ActivationID: "activation-1",
		RevisionID:   "revision-7",
		Revision:     7,
		State:        "active",
		Source:       "slash_command",
	}
	got := runtimeTuttiModeSnapshotFromService(source)
	want := agentruntime.TuttiModeTurnSnapshot{
		ActivationID: "activation-1",
		RevisionID:   "revision-7",
		Revision:     7,
		State:        "active",
		Source:       "slash_command",
	}
	if got == nil || *got != want {
		t.Fatalf("runtime Tutti mode snapshot = %#v, want %#v", got, want)
	}

	// Runtime input owns its copy; later service mutations must not rewrite the
	// turn snapshot that the controller freezes.
	source.State = "inactive"
	if got.State != "active" {
		t.Fatalf("runtime Tutti mode snapshot mutated with source: %#v", got)
	}
}

func TestAgentRuntimeAdapterRejectsNewTurnWithoutCanonicalTurnID(t *testing.T) {
	adapter := newAgentRuntimeAdapter(nil)
	_, err := adapter.Exec(context.Background(), agentservice.RuntimeExecInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
	})
	if !errors.Is(err, agentservice.ErrInvalidArgument) {
		t.Fatalf("Exec() error = %v, want ErrInvalidArgument", err)
	}
}

func TestAgentRuntimeAdapterDelegatesTypedDurableSubmitProvenance(t *testing.T) {
	reporter := &submitProvenanceAdapterTestReporter{}
	controller := agentruntime.NewController(
		[]agentruntime.Adapter{submitProvenanceAdapterTestProvider{}},
		reporter,
	)
	if _, err := controller.Start(context.Background(), agentruntime.StartInput{
		RoomID: "workspace-1", AgentSessionID: "session-1", Provider: "submit-provenance-test", CWD: t.TempDir(),
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	adapter := newAgentRuntimeAdapter(controller)
	if err := adapter.DurablyReportSubmitProvenance(context.Background(), agentservice.RuntimeSubmitProvenanceInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1",
		ClientSubmitID: "submit-1", Content: agentservice.TextPromptContent("hello"),
		DisplayPrompt: "Visible hello",
	}); err != nil {
		t.Fatalf("DurablyReportSubmitProvenance() error = %v", err)
	}
	got := reporter.provenance
	if got.WorkspaceID != "workspace-1" || got.Source.AgentID != "session-1" || len(got.MessageUpdates) != 1 {
		t.Fatalf("provenance report = %#v", got)
	}
	message := got.MessageUpdates[0]
	if message.TurnID != "turn-1" || message.Payload["clientSubmitId"] != "submit-1" || message.Payload["displayPrompt"] != "Visible hello" {
		t.Fatalf("provenance message = %#v", message)
	}
}

func TestAgentRuntimeAdapterReturnsClaudeSDKModelConfigOptions(t *testing.T) {
	t.Setenv("TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER", "1")
	t.Setenv("TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH", "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	controller := agentruntime.NewController(
		[]agentruntime.Adapter{agentruntime.NewClaudeCodeSDKAdapter(agentruntime.NewLocalProcessTransport())},
		nil,
	)
	adapter := newAgentRuntimeAdapter(controller)
	session, err := adapter.Start(ctx, agentservice.RuntimeStartInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "agent-session-1",
		Provider:       agentruntime.ProviderClaudeCode,
		Cwd:            t.TempDir(),
		Title:          "Claude Code",
		Model:          "haiku",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer func() {
		_ = adapter.Close(context.Background(), agentservice.RuntimeCloseInput{
			WorkspaceID:    session.WorkspaceID,
			AgentSessionID: session.ID,
		})
	}()

	if !runtimeContextHasClaudeSDKModelConfigOptions(session.RuntimeContext) {
		t.Fatalf("RuntimeContext = %#v, want SDK model config options", session.RuntimeContext)
	}
}

func runtimeContextHasClaudeSDKModelConfigOptions(runtimeContext map[string]any) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "model" || option["currentValue"] != "haiku" {
			continue
		}
		models, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawDefault bool
		var sawHaiku bool
		for _, model := range models {
			if model["value"] == "default" {
				sawDefault = true
			}
			if model["value"] == "haiku" {
				sawHaiku = true
			}
		}
		return sawDefault && sawHaiku
	}
	return false
}
