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
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
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

func (submitProvenanceAdapterTestProvider) SessionState(session agentruntime.Session) agentruntime.SessionStateSnapshot {
	return agentruntime.SessionStateSnapshot{
		RoomID:         session.RoomID,
		AgentSessionID: session.AgentSessionID,
		Provider:       session.Provider,
		Capabilities:   canonical.NewCapabilitySnapshot([]string{"imageInput", "interrupt"}),
	}
}

type providerAcceptanceMappingTestAdapter struct {
	execCalls           int
	acceptanceExecCalls int
	failure             error
}

func (*providerAcceptanceMappingTestAdapter) Provider() string {
	return "provider-acceptance-mapping-test"
}

func (*providerAcceptanceMappingTestAdapter) Start(
	_ context.Context,
	session agentruntime.Session,
) ([]activityshared.Event, error) {
	event := activityshared.NewSessionStarted(activityshared.EventContext{
		EventID:            "session-started",
		Provider:           activityshared.Provider(session.Provider),
		ProviderSessionID:  "provider-session-1",
		AgentSessionID:     session.AgentSessionID,
		SessionKind:        "root",
		RootAgentSessionID: session.AgentSessionID,
	})
	return []activityshared.Event{event}, nil
}

func (*providerAcceptanceMappingTestAdapter) Resume(
	context.Context,
	agentruntime.Session,
) error {
	return nil
}

func (*providerAcceptanceMappingTestAdapter) Close(
	context.Context,
	agentruntime.Session,
) error {
	return nil
}

func (a *providerAcceptanceMappingTestAdapter) Exec(
	context.Context,
	agentruntime.Session,
	[]agentruntime.PromptContentBlock,
	string,
	string,
	agentruntime.EventSink,
	agentruntime.CommandSnapshotSink,
) ([]activityshared.Event, error) {
	a.execCalls++
	return nil, nil
}

func (a *providerAcceptanceMappingTestAdapter) ExecWithProviderAcceptance(
	_ context.Context,
	_ agentruntime.Session,
	_ []agentruntime.PromptContentBlock,
	_ string,
	_ string,
	_ agentruntime.EventSink,
	_ agentruntime.CommandSnapshotSink,
	reportDispatch agentruntime.ProviderDispatchSink,
	acceptProviderTurn agentruntime.ProviderAcceptanceBarrier,
) ([]activityshared.Event, error) {
	a.acceptanceExecCalls++
	if a.failure != nil {
		reportDispatch(agentruntime.ProviderDispatchResult{
			Disposition: agentruntime.DispatchDispositionRejected,
			Failure:     a.failure,
		})
		return nil, a.failure
	}
	if err := acceptProviderTurn(agentruntime.ProviderAcceptanceReceipt{
		Source:            agentruntime.AcceptanceSourceTurnStartResponse,
		ProviderSessionID: "provider-session-1",
		ProviderTurnID:    "provider-turn-1",
	}); err != nil {
		return nil, err
	}
	return nil, nil
}

func (*providerAcceptanceMappingTestAdapter) Cancel(
	context.Context,
	agentruntime.Session,
	string,
) ([]activityshared.Event, error) {
	return nil, nil
}

func (*providerAcceptanceMappingTestAdapter) ForkCapabilities(
	context.Context,
	agentruntime.Session,
) (agentruntime.SessionForkCapabilities, error) {
	return agentruntime.SessionForkCapabilities{ThroughTurn: true}, nil
}

func (*providerAcceptanceMappingTestAdapter) Fork(
	context.Context,
	agentruntime.SessionForkInput,
) (agentruntime.SessionForkResult, error) {
	return agentruntime.SessionForkResult{}, nil
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

func TestAgentRuntimeAdapterPreservesProviderAcceptanceRequirement(t *testing.T) {
	provider := &providerAcceptanceMappingTestAdapter{}
	reporter := &submitProvenanceAdapterTestReporter{}
	controller := agentruntime.NewController(
		[]agentruntime.Adapter{provider},
		reporter,
	)
	adapter := newAgentRuntimeAdapter(controller)
	startResult, err := adapter.Start(t.Context(), agentservice.RuntimeStartInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Provider: provider.Provider(),
	})
	if err != nil {
		t.Fatal(err)
	}
	session := startResult.Session
	result, err := adapter.Exec(t.Context(), agentservice.RuntimeExecInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		TurnID: "canonical-turn-1", ClientSubmitID: "opaque-submit-1",
		CanonicalSubmitOccurredAtUnixMS: 1,
		Content:                         agentservice.TextPromptContent("hello"),
		RequireProviderAcceptance:       true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderDispatch.Disposition != agenthost.RuntimeDispatchDispositionApplied ||
		result.ProviderDispatch.Acceptance == nil ||
		result.ProviderDispatch.Acceptance.ProviderTurnID != "provider-turn-1" {
		t.Fatalf("provider dispatch = %#v", result.ProviderDispatch)
	}
	if provider.acceptanceExecCalls != 1 || provider.execCalls != 0 {
		t.Fatalf(
			"provider calls acceptance=%d ordinary=%d",
			provider.acceptanceExecCalls,
			provider.execCalls,
		)
	}
	if session.ProviderSessionID != "provider-session-1" {
		t.Fatalf("provider session id = %q", session.ProviderSessionID)
	}
}

func TestAgentRuntimeAdapterPreservesRejectedDispatchWithProviderFailure(t *testing.T) {
	providerFailure := &agentruntime.AppError{
		Code:    "auth_required",
		Message: "Claude Code needs authentication",
	}
	provider := &providerAcceptanceMappingTestAdapter{failure: providerFailure}
	controller := agentruntime.NewController(
		[]agentruntime.Adapter{provider},
		&submitProvenanceAdapterTestReporter{},
	)
	adapter := newAgentRuntimeAdapter(controller)
	if _, err := adapter.Start(t.Context(), agentservice.RuntimeStartInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-rejected",
		Provider: provider.Provider(),
	}); err != nil {
		t.Fatal(err)
	}

	result, err := adapter.Exec(t.Context(), agentservice.RuntimeExecInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-rejected",
		TurnID: "canonical-turn-rejected", Content: agentservice.TextPromptContent("hello"),
		RequireProviderAcceptance: true,
	})
	var mapped *agenthost.ProviderError
	if !errors.As(err, &mapped) || mapped.Code != "auth_required" {
		t.Fatalf("Exec() error = %#v, want auth_required ProviderError", err)
	}
	if result.ProviderDispatch.Disposition != agenthost.RuntimeDispatchDispositionRejected ||
		result.ProviderDispatch.Acceptance != nil {
		t.Fatalf("provider dispatch = %#v, want rejected", result.ProviderDispatch)
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
		CanonicalSubmitOccurredAtUnixMS: 1_234,
		DisplayPrompt:                   "Visible hello",
	}); err != nil {
		t.Fatalf("DurablyReportSubmitProvenance() error = %v", err)
	}
	got := reporter.provenance
	if got.WorkspaceID != "workspace-1" || got.Source.AgentID != "session-1" || len(got.MessageUpdates) != 1 {
		t.Fatalf("provenance report = %#v", got)
	}
	message := got.MessageUpdates[0]
	if message.TurnID != "turn-1" || message.Seq != 1_234 || message.OccurredAtUnixMS != 1_234 ||
		message.Payload["clientSubmitId"] != "submit-1" || message.Payload["displayPrompt"] != "Visible hello" {
		t.Fatalf("provenance message = %#v", message)
	}
}

func TestAgentRuntimeAdapterPreservesProviderCapabilities(t *testing.T) {
	controller := agentruntime.NewController(
		[]agentruntime.Adapter{submitProvenanceAdapterTestProvider{}},
		nil,
	)
	adapter := newAgentRuntimeAdapter(controller)

	result, err := adapter.Start(t.Context(), agentservice.RuntimeStartInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-capabilities",
		Provider:       submitProvenanceAdapterTestProvider{}.Provider(),
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if result.Session.Capabilities == nil ||
		len(result.Session.Capabilities.Values) != 2 ||
		result.Session.Capabilities.Values[0] != "imageInput" ||
		result.Session.Capabilities.Values[1] != "interrupt" {
		t.Fatalf("capabilities = %#v, want provider state capabilities", result.Session.Capabilities)
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
	startResult, err := adapter.Start(ctx, agentservice.RuntimeStartInput{
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
	session := startResult.Session
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
