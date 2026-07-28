package cli

import (
	"context"
	"errors"
	"testing"
)

func newTestRegistry(t *testing.T, commands ...Command) *Registry {
	t.Helper()
	registry := newRegistry()
	for _, command := range commands {
		if err := registry.Register(command); err != nil {
			t.Fatalf("Register: %v", err)
		}
	}
	return registry
}

func TestRegistryListsCapabilities(t *testing.T) {
	registry := newTestRegistry(t, testCommand("doctor.ping"))
	capabilities := registry.Capabilities(context.Background(), InvokeContext{Source: "cli"})
	if len(capabilities) != 1 {
		t.Fatalf("len(capabilities) = %d, want 1", len(capabilities))
	}
	if capabilities[0].ID != "doctor.ping" {
		t.Fatalf("capability id = %q", capabilities[0].ID)
	}
}

func TestRegistryInvokesCommand(t *testing.T) {
	registry := newTestRegistry(t, testCommand("doctor.ping"))
	output, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "doctor.ping",
		Context:   InvokeContext{Source: "cli"},
	})
	if err != nil {
		t.Fatalf("Invoke: %v", err)
	}
	if output.Kind != OutputModePlain || output.Text != "ok" {
		t.Fatalf("output = %#v", output)
	}
}

func TestRegistryReturnsCommandNotFound(t *testing.T) {
	registry := newTestRegistry(t, testCommand("doctor.ping"))
	_, err := registry.Invoke(context.Background(), InvokeRequest{CommandID: "missing"})
	if !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("err = %v, want ErrCommandNotFound", err)
	}
}

func TestRegistryRejectsDuplicateCommandID(t *testing.T) {
	registry := newRegistry()
	_ = registry.Register(testCommand("doctor.ping"))
	err := registry.Register(testCommand("doctor.ping"))
	if !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("err = %v, want ErrInvalidCommand", err)
	}
}

type testProvider struct {
	appID    string
	commands []Command
}

func (p testProvider) AppID() string {
	return p.appID
}

func (p testProvider) Commands() []Command {
	return p.commands
}

func TestRegistryFromProviders(t *testing.T) {
	registry, err := NewRegistryFromProviders(testProvider{
		appID:    "diagnostics",
		commands: []Command{testCommand("diagnostics.doctor.ping")},
	})
	if err != nil {
		t.Fatalf("NewRegistryFromProviders: %v", err)
	}
	capabilities := registry.Capabilities(context.Background(), InvokeContext{Source: "cli"})
	if len(capabilities) != 1 || capabilities[0].ID != "diagnostics.doctor.ping" {
		t.Fatalf("capabilities = %#v", capabilities)
	}
}

func TestRegistryCapabilitiesKeepRegistrationOrder(t *testing.T) {
	registry := newTestRegistry(
		t,
		testCommandWithPath("diagnostics.second", []string{"second"}),
		testCommandWithPath("diagnostics.first", []string{"first"}),
	)
	capabilities := registry.Capabilities(context.Background(), InvokeContext{Source: "cli"})
	if len(capabilities) != 2 {
		t.Fatalf("len(capabilities) = %d, want 2", len(capabilities))
	}
	if capabilities[0].ID != "diagnostics.second" || capabilities[1].ID != "diagnostics.first" {
		t.Fatalf("capabilities = %#v", capabilities)
	}
}

func TestRegistryProviderCapabilityFilterHidesStaticCapabilitiesOnlyFromList(t *testing.T) {
	provider := &filteringTestProvider{
		testProvider: testProvider{
			appID: "diagnostics",
			commands: []Command{
				testCommandWithPath("diagnostics.hidden", []string{"hidden"}),
				testCommandWithPath("diagnostics.second", []string{"second"}),
				testCommandWithPath("diagnostics.first", []string{"first"}),
			},
		},
		visibleIDs: map[string]bool{
			"diagnostics.second": true,
			"diagnostics.first":  true,
		},
	}
	registry, err := NewRegistryFromProviders(provider)
	if err != nil {
		t.Fatalf("NewRegistryFromProviders: %v", err)
	}
	registry.AppCommands = fakeDynamicCommandRegistry{
		capabilities: []Capability{{
			ID:      "dynamic.app.run",
			Path:    []string{"app", "run"},
			Summary: "Run dynamic app command",
			Source:  CapabilitySource{Kind: CapabilitySourceApp, AppID: "dynamic-app"},
		}},
	}

	capabilities := registry.Capabilities(context.Background(), InvokeContext{Source: "cli", WorkspaceID: "ws-1"})
	if got, want := capabilityIDs(capabilities), []string{"diagnostics.second", "diagnostics.first", "dynamic.app.run"}; !stringSlicesEqual(got, want) {
		t.Fatalf("capability ids = %#v, want %#v", got, want)
	}
	if len(provider.contexts) != 1 || provider.contexts[0].WorkspaceID != "ws-1" {
		t.Fatalf("filter contexts = %#v, want workspace ws-1", provider.contexts)
	}

	output, err := registry.Invoke(context.Background(), InvokeRequest{CommandID: "diagnostics.hidden"})
	if err != nil {
		t.Fatalf("Invoke hidden command: %v", err)
	}
	if output.Kind != OutputModePlain || output.Text != "ok" {
		t.Fatalf("hidden command output = %#v", output)
	}
}

func TestRegistryCapabilitiesCanSkipProviderFilters(t *testing.T) {
	provider := &filteringTestProvider{
		testProvider: testProvider{
			appID: "diagnostics",
			commands: []Command{
				testCommandWithPath("diagnostics.hidden", []string{"hidden"}),
				testCommandWithPath("diagnostics.visible", []string{"visible"}),
			},
		},
		visibleIDs: map[string]bool{
			"diagnostics.visible": true,
		},
	}
	registry, err := NewRegistryFromProviders(provider)
	if err != nil {
		t.Fatalf("NewRegistryFromProviders: %v", err)
	}

	capabilities := registry.Capabilities(context.Background(), InvokeContext{
		Source:                "cli",
		SkipCapabilityFilters: true,
		WorkspaceID:           "ws-1",
	})
	if got, want := capabilityIDs(capabilities), []string{"diagnostics.hidden", "diagnostics.visible"}; !stringSlicesEqual(got, want) {
		t.Fatalf("capability ids = %#v, want %#v", got, want)
	}
	if len(provider.contexts) != 0 {
		t.Fatalf("filter contexts = %#v, want none", provider.contexts)
	}
}

func TestRegistryHidesIntegrationCapabilitiesFromDefaultList(t *testing.T) {
	registry := newTestRegistry(
		t,
		testCommandWithPath("diagnostics.visible", []string{"visible"}),
		Command{
			Capability: Capability{
				ID:         "diagnostics.internal",
				Path:       []string{"internal"},
				Summary:    "Run internal command",
				Visibility: CapabilityVisibilityIntegration,
				Output: CapabilityOutput{
					DefaultMode: OutputModePlain,
					JSON:        true,
				},
			},
			Handler: func(context.Context, InvokeRequest) (CommandOutput, error) {
				return CommandOutput{
					Kind: OutputModePlain,
					Text: "internal ok",
				}, nil
			},
		},
	)
	capabilities := registry.Capabilities(context.Background(), InvokeContext{Source: "cli"})
	if got, want := capabilityIDs(capabilities), []string{"diagnostics.visible"}; !stringSlicesEqual(got, want) {
		t.Fatalf("capability ids = %#v, want %#v", got, want)
	}

	capabilities = registry.Capabilities(context.Background(), InvokeContext{
		Source:                         "cli",
		IncludeIntegrationCapabilities: true,
	})
	if got, want := capabilityIDs(capabilities), []string{"diagnostics.visible", "diagnostics.internal"}; !stringSlicesEqual(got, want) {
		t.Fatalf("capability ids with integration = %#v, want %#v", got, want)
	}

	output, err := registry.Invoke(context.Background(), InvokeRequest{CommandID: "diagnostics.internal"})
	if err != nil {
		t.Fatalf("Invoke integration command: %v", err)
	}
	if output.Text != "internal ok" {
		t.Fatalf("output = %#v", output)
	}
}

func TestRegistryAgentSessionProjectionGovernsDiscoveryAndInvocation(t *testing.T) {
	read := testCommandWithPath("issue-manager.issue.get", []string{"issue", "get"})
	mutate := testCommandWithPath("issue-manager.issue.update", []string{"issue", "update"})
	agentStart := testCommandWithPath("agent-context.agent.start", []string{"agent", "start"})
	verdict := testCommandWithPath(
		"tutti-goal-review.goal-review.verdict",
		[]string{"goal-review", "verdict"},
	)
	verdict.Capability.Visibility = CapabilityVisibilityIntegration
	registry := newTestRegistry(t, read, mutate, agentStart, verdict)
	dynamicInvoked := false
	registry.AppCommands = fakeDynamicCommandRegistry{
		capabilities: []Capability{{
			ID:      "workspace-app.mutate",
			Path:    []string{"app", "mutate"},
			Summary: "Mutate app state",
			Source: CapabilitySource{
				Kind: CapabilitySourceApp,
			},
		}},
		invoked: &dynamicInvoked,
	}
	registry.AgentSessionCapabilities = staticAgentSessionCapabilityResolver{
		projection: AgentSessionCapabilityProjection{
			AllowedIDs: []string{
				"issue-manager.issue.get",
				"tutti-goal-review.goal-review.verdict",
			},
			IncludeIntegrationIDs: []string{"tutti-goal-review.goal-review.verdict"},
			ExcludeIDs:            []string{"issue-manager.issue.update"},
		},
	}
	invokeContext := InvokeContext{
		Source: "cli", WorkspaceID: "workspace-1",
		AgentSessionID: "review-session-1",
	}

	capabilities := registry.Capabilities(context.Background(), invokeContext)
	if got, want := capabilityIDs(capabilities), []string{
		"issue-manager.issue.get",
		"tutti-goal-review.goal-review.verdict",
	}; !stringSlicesEqual(got, want) {
		t.Fatalf("reviewer capability ids = %#v, want %#v", got, want)
	}
	if _, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "issue-manager.issue.update",
		Context:   invokeContext,
	}); !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("excluded reviewer invocation error = %v, want ErrCommandNotFound", err)
	}
	if _, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "agent-context.agent.start",
		Context:   invokeContext,
	}); !errors.Is(err, ErrCommandNotFound) {
		t.Fatalf("non-allowlisted reviewer invocation error = %v, want ErrCommandNotFound", err)
	}
	if _, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "workspace-app.mutate",
		Context:   invokeContext,
	}); !errors.Is(err, ErrCommandNotFound) || dynamicInvoked {
		t.Fatalf(
			"dynamic reviewer invocation error/invoked = %v/%v, want rejected before handler",
			err, dynamicInvoked,
		)
	}
	if _, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "tutti-goal-review.goal-review.verdict",
		Context:   invokeContext,
	}); err != nil {
		t.Fatalf("included reviewer verdict invocation error = %v", err)
	}
}

func TestRegistryAgentSessionProjectionFailsClosedWhenUnavailable(t *testing.T) {
	registry := newTestRegistry(t, testCommand("doctor.ping"))
	registry.AgentSessionCapabilities = staticAgentSessionCapabilityResolver{
		err: errors.New("session projection unavailable"),
	}
	invokeContext := InvokeContext{
		Source: "cli", WorkspaceID: "workspace-1",
		AgentSessionID: "review-session-1",
	}
	if capabilities := registry.Capabilities(context.Background(), invokeContext); len(capabilities) != 0 {
		t.Fatalf("capabilities = %#v, want fail-closed empty list", capabilities)
	}
	if _, err := registry.Invoke(context.Background(), InvokeRequest{
		CommandID: "doctor.ping",
		Context:   invokeContext,
	}); !errors.Is(err, ErrServiceUnavailable) {
		t.Fatalf("Invoke() error = %v, want ErrServiceUnavailable", err)
	}
}

type staticAgentSessionCapabilityResolver struct {
	projection AgentSessionCapabilityProjection
	err        error
}

func (resolver staticAgentSessionCapabilityResolver) ResolveAgentSessionCapabilityProjection(
	context.Context,
	string,
	string,
) (AgentSessionCapabilityProjection, error) {
	return resolver.projection, resolver.err
}

type filteringTestProvider struct {
	testProvider
	visibleIDs map[string]bool
	contexts   []InvokeContext
}

func (p *filteringTestProvider) FilterCapabilities(_ context.Context, invokeContext InvokeContext, capabilities []Capability) []Capability {
	p.contexts = append(p.contexts, invokeContext)
	result := make([]Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		if p.visibleIDs[capability.ID] {
			result = append(result, capability)
		}
	}
	return result
}

type fakeDynamicCommandRegistry struct {
	capabilities []Capability
	invoked      *bool
}

func (f fakeDynamicCommandRegistry) Capabilities(context.Context, InvokeContext) []Capability {
	return append([]Capability(nil), f.capabilities...)
}

func (f fakeDynamicCommandRegistry) Invoke(context.Context, InvokeRequest) (CommandOutput, error) {
	if f.invoked != nil {
		*f.invoked = true
	}
	return CommandOutput{Kind: OutputModePlain, Text: "dynamic invoked"}, nil
}

func capabilityIDs(capabilities []Capability) []string {
	ids := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		ids = append(ids, capability.ID)
	}
	return ids
}

func stringSlicesEqual(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func testCommand(id string) Command {
	return testCommandWithPath(id, []string{"doctor", "ping"})
}

func testCommandWithPath(id string, path []string) Command {
	return Command{
		Capability: Capability{
			ID:      id,
			Path:    path,
			Summary: "Check CLI command routing",
			Output: CapabilityOutput{
				DefaultMode: OutputModePlain,
				JSON:        true,
			},
		},
		Handler: func(context.Context, InvokeRequest) (CommandOutput, error) {
			return CommandOutput{
				Kind: OutputModePlain,
				Text: "ok",
			}, nil
		},
	}
}
