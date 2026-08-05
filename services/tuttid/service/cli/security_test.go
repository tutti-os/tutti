package cli

import (
	"context"
	"errors"
	"testing"
)

func TestRegistryValidatesStaticCapabilityInputBeforeHandler(t *testing.T) {
	invoked := false
	command := testCommand("diagnostics.run")
	command.Capability.InputSchema = map[string]any{
		"type":                 "object",
		"required":             []string{"mode"},
		"additionalProperties": false,
		"properties": map[string]any{
			"mode":  map[string]any{"type": "string", "enum": []string{"safe"}},
			"count": map[string]any{"type": "integer", "minimum": 1, "maximum": 3},
		},
	}
	command.Handler = func(context.Context, InvokeRequest) (CommandOutput, error) {
		invoked = true
		return CommandOutput{}, nil
	}
	registry := newTestRegistry(t, command)

	for name, input := range map[string]map[string]any{
		"missing required": {"count": 1},
		"wrong enum":       {"mode": "unsafe"},
		"wrong type":       {"mode": "safe", "count": 1.5},
		"out of range":     {"mode": "safe", "count": 4},
		"unknown input":    {"mode": "safe", "extra": true},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := registry.Invoke(context.Background(), InvokeRequest{
				CommandID: "diagnostics.run",
				Input:     input,
			})
			if !errors.Is(err, ErrInvalidInput) || InvokeErrorReason(err) != "input_schema_mismatch" {
				t.Fatalf("Invoke() error = %v, want input_schema_mismatch", err)
			}
			if invoked {
				t.Fatal("handler invoked for invalid input")
			}
		})
	}

	if _, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "diagnostics.run",
		Input:     map[string]any{"mode": "safe", "count": 2},
	}); err != nil {
		t.Fatalf("Invoke(valid): %v", err)
	}
	if !invoked {
		t.Fatal("handler was not invoked for valid input")
	}
}

func TestRegistryValidatesDynamicCapabilityInputBeforeHandler(t *testing.T) {
	invoked := false
	registry := newRegistry()
	registry.AppCommands = fakeDynamicCommandRegistry{
		capabilities: []Capability{{
			ID: "dynamic.app.run",
			InputSchema: map[string]any{
				"type":     "object",
				"required": []string{"name"},
				"properties": map[string]any{
					"name": map[string]any{"type": "string"},
				},
			},
		}},
		invoked: &invoked,
	}

	_, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "dynamic.app.run",
		Input:     map[string]any{"name": 7},
	})
	if !errors.Is(err, ErrInvalidInput) || invoked {
		t.Fatalf("Invoke() error/invoked = %v/%v, want rejected before dynamic registry", err, invoked)
	}
}

func TestRegistryInputSchemaSupportsOneOf(t *testing.T) {
	command := testCommand("workspace.app.open")
	command.Capability.InputSchema = map[string]any{
		"type": "object",
		"properties": map[string]any{
			"param": map[string]any{
				"oneOf": []map[string]any{
					{"type": "string"},
					{"type": "array", "items": map[string]any{"type": "string"}},
				},
			},
		},
	}
	registry := newTestRegistry(t, command)

	for _, value := range []any{"key=value", []string{"a=1", "b=2"}} {
		if _, err := registry.Invoke(context.Background(), InvokeRequest{
			CommandID: "workspace.app.open",
			Input:     map[string]any{"param": value},
		}); err != nil {
			t.Fatalf("Invoke(param=%#v): %v", value, err)
		}
	}
	if _, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "workspace.app.open",
		Input:     map[string]any{"param": true},
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("Invoke(invalid oneOf) error = %v, want ErrInvalidInput", err)
	}
}

func TestHostRouteFreezesTrustedInvocationContext(t *testing.T) {
	var received InvokeRequest
	command := testCommand("diagnostics.run")
	command.Handler = func(_ context.Context, request InvokeRequest) (CommandOutput, error) {
		received = request
		return CommandOutput{Kind: OutputModePlain, Text: "ok"}, nil
	}
	registry := newTestRegistry(t, command)
	route, err := NewHostRoute(registry, HostRouteContext{
		AppID:           "connector.weather",
		WorkspaceID:     "workspace-trusted",
		AgentSessionID:  "session-trusted",
		ParentCommandID: "parent-trusted",
		Source:          "connector",
	})
	if err != nil {
		t.Fatalf("NewHostRoute: %v", err)
	}
	registry.AgentSessionCapabilities = staticAgentSessionCapabilityResolver{
		projection: AgentSessionCapabilityProjection{AllowedIDs: []string{"diagnostics.run"}},
	}

	if _, err := route.Invoke(context.Background(), HostInvokeRequest{
		CommandID: "diagnostics.run",
		Input:     map[string]any{"value": "connector-owned"},
	}); err != nil {
		t.Fatalf("Invoke: %v", err)
	}
	want := InvokeContext{
		AppID:           "connector.weather",
		WorkspaceID:     "workspace-trusted",
		AgentSessionID:  "session-trusted",
		ParentCommandID: "parent-trusted",
		Source:          "connector",
	}
	if received.Context != want {
		t.Fatalf("handler context = %#v, want %#v", received.Context, want)
	}
}

func TestNewHostRouteRequiresHostSource(t *testing.T) {
	if _, err := NewHostRoute(newRegistry(), HostRouteContext{}); err == nil {
		t.Fatal("NewHostRoute() error = nil, want missing source rejection")
	}
}
