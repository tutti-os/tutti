package cli_test

import (
	"context"
	"strings"
	"testing"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/providers/agentcontext"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/providers/browser"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/providers/computer"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/providers/diagnostics"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/providers/issuemanager"
)

func TestBuiltinProviderCapabilitiesAreFrameworkCompliant(t *testing.T) {
	providers := []cliservice.Provider{
		diagnostics.NewProvider(),
		issuemanager.NewProvider(nil, nil, nil),
		agentcontext.NewProviderWithLaunchPublisher(nil, nil, nil),
		browser.NewProvider(nil, nil),
		computer.NewProvider(nil, nil),
	}
	total := 0
	for _, provider := range providers {
		for _, command := range provider.Commands() {
			total++
			capability := command.Capability
			if strings.TrimSpace(capability.ID) == "" {
				t.Fatalf("%s command has empty id", provider.AppID())
			}
			if len(capability.Path) == 0 {
				t.Fatalf("%s command %s has empty path", provider.AppID(), capability.ID)
			}
			if strings.TrimSpace(capability.Summary) == "" {
				t.Fatalf("%s command %s has empty summary", provider.AppID(), capability.ID)
			}
			if strings.TrimSpace(capability.Description) == "" {
				t.Fatalf("%s command %s has empty description", provider.AppID(), capability.ID)
			}
			if got := capability.InputSchema["type"]; got != "object" {
				t.Fatalf("%s command %s schema type = %#v", provider.AppID(), capability.ID, got)
			}
			if _, ok := capability.InputSchema["properties"].(map[string]any); !ok {
				t.Fatalf("%s command %s schema properties = %#v", provider.AppID(), capability.ID, capability.InputSchema["properties"])
			}
			if capability.Output.DefaultMode == "" {
				t.Fatalf("%s command %s has empty default output mode", provider.AppID(), capability.ID)
			}
			if command.Handler == nil {
				t.Fatalf("%s command %s has nil handler", provider.AppID(), capability.ID)
			}
		}
	}
	if total == 0 {
		t.Fatal("no builtin commands registered")
	}
}

func TestBuiltinComplianceDoesNotIncludeAppCLICommands(t *testing.T) {
	registry, err := cliservice.NewRegistryFromProviders(diagnostics.NewProvider())
	if err != nil {
		t.Fatalf("NewRegistryFromProviders: %v", err)
	}
	registry.AppCommands = fakeDynamicCommands{}
	capabilities := registry.Capabilities(context.Background(), cliservice.InvokeContext{})
	foundAppCommand := false
	for _, capability := range capabilities {
		if capability.Source.Kind == cliservice.CapabilitySourceApp && capability.ID == "app.echo" {
			foundAppCommand = true
		}
	}
	if !foundAppCommand {
		t.Fatalf("app capability was not preserved: %#v", capabilities)
	}
}

type fakeDynamicCommands struct{}

func (fakeDynamicCommands) Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability {
	return []cliservice.Capability{{
		ID:          "app.echo",
		Path:        []string{"app", "echo"},
		Summary:     "Echo app command",
		Description: "App-owned command outside builtin framework compliance.",
		Source:      cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceApp, AppID: "app"},
	}}
}

func (fakeDynamicCommands) Invoke(context.Context, cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
	return cliservice.CommandOutput{}, nil
}
