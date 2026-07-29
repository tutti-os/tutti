package tuttimodeactivation

import (
	"context"
	"errors"
	"testing"

	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

type recordingActivations struct {
	input  tuttimodeactivationservice.SetInput
	result tuttimodeactivationservice.SetResult
	err    error
	calls  int
}

func (r *recordingActivations) Set(
	_ context.Context,
	input tuttimodeactivationservice.SetInput,
) (tuttimodeactivationservice.SetResult, error) {
	r.calls++
	r.input = input
	return r.result, r.err
}

func invokeContext(sessionID string) framework.InvokeContext {
	return framework.InvokeContext{
		WorkspaceID: "workspace-1",
		Request: cliservice.InvokeRequest{
			Context: cliservice.InvokeContext{AgentSessionID: sessionID},
		},
	}
}

func TestProviderExposesModeSetCommand(t *testing.T) {
	commands := NewProvider(&recordingActivations{}).Commands()
	if len(commands) != 1 {
		t.Fatalf("commands = %#v", commands)
	}
	capability := commands[0].Capability
	if capability.ID != "tutti-mode.mode.set" {
		t.Fatalf("command id = %q", capability.ID)
	}
	if capability.Visibility != cliservice.CapabilityVisibilityPublic {
		t.Fatalf("command visibility = %q", capability.Visibility)
	}
	properties := capability.InputSchema["properties"].(map[string]any)
	state, ok := properties["state"].(map[string]any)
	if !ok {
		t.Fatalf("state schema = %#v", properties)
	}
	enum, ok := state["enum"].([]string)
	if !ok || len(enum) != 2 || enum[0] != "active" || enum[1] != "inactive" {
		t.Fatalf("state enum = %#v", state["enum"])
	}
}

func TestRunModeSetSendsAgentCommandSource(t *testing.T) {
	for _, state := range []string{"active", "inactive"} {
		state := state
		t.Run(state, func(t *testing.T) {
			activations := &recordingActivations{
				result: tuttimodeactivationservice.SetResult{
					Changed: true,
					Activation: &activationbiz.Activation{
						ID: "activation-1",
						CurrentRevision: activationbiz.Revision{
							Revision: 3, State: activationbiz.State(state),
							Source: activationbiz.SourceAgentCommand,
						},
					},
				},
			}
			result, err := NewProvider(activations).runModeSet(
				context.Background(), invokeContext("session-1"), modeSetInput{State: state},
			)
			if err != nil {
				t.Fatalf("runModeSet() error = %v", err)
			}
			if activations.input.Source != activationbiz.SourceAgentCommand {
				t.Fatalf("source = %q, want agent_command", activations.input.Source)
			}
			if string(activations.input.State) != state {
				t.Fatalf("state = %q, want %q", activations.input.State, state)
			}
			if activations.input.AgentSessionID != "session-1" || activations.input.WorkspaceID != "workspace-1" {
				t.Fatalf("identity = %#v", activations.input)
			}
			if activations.input.Effect != nil || activations.input.Speed != nil {
				t.Fatalf("effect/speed should be preserved as nil: %#v", activations.input)
			}
			payload := result.(map[string]any)
			if payload["changed"] != true || payload["state"] != state || payload["activationId"] != "activation-1" {
				t.Fatalf("payload = %#v", payload)
			}
		})
	}
}

func TestRunModeSetRequiresSession(t *testing.T) {
	_, err := NewProvider(&recordingActivations{}).runModeSet(
		context.Background(), invokeContext(""), modeSetInput{State: "active"},
	)
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("runModeSet() error = %v, want ErrInvalidInput", err)
	}
}

func TestRunModeSetRequiresActivationService(t *testing.T) {
	_, err := NewProvider(nil).runModeSet(
		context.Background(), invokeContext("session-1"), modeSetInput{State: "active"},
	)
	if !errors.Is(err, cliservice.ErrServiceUnavailable) {
		t.Fatalf("runModeSet() error = %v, want ErrServiceUnavailable", err)
	}
}
