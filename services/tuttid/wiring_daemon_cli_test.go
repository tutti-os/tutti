package main

import (
	"context"
	"errors"
	"testing"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	appclicli "github.com/tutti-os/tutti/services/tuttid/service/cli/appcli"
)

func TestBuildDaemonCLIRegistryOmitsAgentTuttiModeMutation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	registry, err := buildDaemonCLIRegistry(daemonCLIRegistryInput{
		AppCommands: appclicli.NewRegistry(nil, nil),
	})
	if err != nil {
		t.Fatalf("buildDaemonCLIRegistry() error = %v", err)
	}
	for _, capability := range registry.Capabilities(
		ctx,
		cliservice.InvokeContext{Source: "cli"},
	) {
		if capability.ID == "tutti-mode.mode.set" {
			t.Fatalf("Agent Tutti Mode mutation remains registered: %#v", capability)
		}
	}
	_, err = registry.Invoke(ctx, cliservice.InvokeRequest{
		CommandID: "tutti-mode.mode.set",
		Input:     map[string]any{"state": "active"},
		Context:   cliservice.InvokeContext{Source: "cli"},
	})
	if !errors.Is(err, cliservice.ErrCommandNotFound) {
		t.Fatalf("Invoke(tutti-mode.mode.set) error = %v, want ErrCommandNotFound", err)
	}
}
