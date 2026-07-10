package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	activityevents "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type failingRuntimeStartAdapter struct{}

func (failingRuntimeStartAdapter) Provider() string { return "failing-start" }

func (failingRuntimeStartAdapter) Start(context.Context, agentruntime.Session) ([]activityevents.Event, error) {
	return nil, errors.New("provider configuration is invalid")
}

func (failingRuntimeStartAdapter) Resume(context.Context, agentruntime.Session) error { return nil }

func (failingRuntimeStartAdapter) Close(context.Context, agentruntime.Session) error { return nil }

func (failingRuntimeStartAdapter) Exec(
	context.Context,
	agentruntime.Session,
	[]agentruntime.PromptContentBlock,
	string,
	string,
	agentruntime.EventSink,
	agentruntime.CommandSnapshotSink,
) ([]activityevents.Event, error) {
	return nil, nil
}

func (failingRuntimeStartAdapter) Cancel(context.Context, agentruntime.Session, string) ([]activityevents.Event, error) {
	return nil, nil
}

func TestAgentRuntimeAdapterReturnsEmbeddedStartFailure(t *testing.T) {
	controller := agentruntime.NewController([]agentruntime.Adapter{failingRuntimeStartAdapter{}}, nil)
	adapter := newAgentRuntimeAdapter(controller)

	_, err := adapter.Start(t.Context(), agentservice.RuntimeStartInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "agent-session-failed",
		Provider:       "failing-start",
		Cwd:            t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "provider configuration is invalid") {
		t.Fatalf("Start() error = %v, want provider start failure", err)
	}
	session, ok := controller.Session("workspace-1", "agent-session-failed")
	if !ok {
		t.Fatal("failed runtime session was not retained")
	}
	if session.Status != agentruntime.SessionStatusFailed {
		t.Fatalf("session status = %q, want failed", session.Status)
	}
}

func TestAgentRuntimeAdapterReturnsClaudeSDKModelConfigOptions(t *testing.T) {
	t.Setenv("TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER", "1")

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
