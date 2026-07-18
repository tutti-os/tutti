package main

import (
	"context"
	"errors"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type unavailableAgentExtensionResumeResolver struct{}

func (unavailableAgentExtensionResumeResolver) ResolveAdapter(context.Context, agentruntime.AdapterResolveInput) (agentruntime.Adapter, error) {
	return nil, errors.New("adapter resolution must not run during resume eligibility checks")
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
