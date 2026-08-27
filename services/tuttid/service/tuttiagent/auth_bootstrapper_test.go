package tuttiagent

import (
	"context"
	"reflect"
	"testing"

	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

type authCommandResolverStub struct {
	resolution agentstatusservice.ProviderCommandResolution
}

func (s authCommandResolverStub) ResolveProviderCommand(
	context.Context,
	string,
) (agentstatusservice.ProviderCommandResolution, error) {
	return s.resolution, nil
}

func TestAuthBootstrapperResolvesProviderCommandEnvironment(t *testing.T) {
	providerEnv := []string{"PATH=provider-path", "TUTTI_APP_NODE=managed-node"}
	wantEnv := []string{"PATH=resolved-path", "TUTTI_APP_NODE=managed-node", "BASE=value"}
	var receivedOverrides []string
	bootstrapper := &AuthBootstrapper{
		ProviderCommands: authCommandResolverStub{
			resolution: agentstatusservice.ProviderCommandResolution{
				Command: []string{"provider-launcher", "app-server"},
				Env:     providerEnv,
			},
		},
		ResolveEnv: func(overrides []string) []string {
			receivedOverrides = append([]string(nil), overrides...)
			return append([]string(nil), wantEnv...)
		},
		ResolveCommand: func(command string, env []string) string {
			if command != "provider-launcher" {
				t.Fatalf("command to resolve = %q, want provider-launcher", command)
			}
			if !reflect.DeepEqual(env, wantEnv) {
				t.Fatalf("command resolution environment = %v, want %v", env, wantEnv)
			}
			return "resolved-provider-launcher"
		},
	}

	command, err := bootstrapper.resolveLoginCommand(t.Context())
	if err != nil {
		t.Fatalf("resolveLoginCommand() error = %v", err)
	}
	if command.BinaryPath != "resolved-provider-launcher" {
		t.Fatalf("binary = %q, want resolved-provider-launcher", command.BinaryPath)
	}
	if !reflect.DeepEqual(receivedOverrides, providerEnv) {
		t.Fatalf("environment overrides = %v, want %v", receivedOverrides, providerEnv)
	}
	if !reflect.DeepEqual(command.Env, wantEnv) {
		t.Fatalf("resolved environment = %v, want %v", command.Env, wantEnv)
	}
}
