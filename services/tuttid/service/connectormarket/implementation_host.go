package connectormarket

import (
	"context"
	"errors"
	"os"
	"runtime"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	"github.com/tutti-os/tutti/packages/connector/runtime/command"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type PreparedArtifactResolver = implementationhost.PreparedArtifactResolver
type ConnectorRuntimeResolver = connectorruntime.ConnectorRuntimeResolver

type ConnectorCommandRegistry struct {
	runtime *implementationhost.CommandRegistry
}

type ImplementationHostConfig struct {
	Artifacts         PreparedArtifactResolver
	CLIInstallations  market.CLIInstallationManager
	Runtimes          ConnectorRuntimeResolver
	Processes         agentruntime.ProcessTransport
	Commands          *ConnectorCommandRegistry
	StateRoot         string
	UserHome          string
	MCPStartupTimeout time.Duration
}

// ImplementationHost is the tutt id product adapter around the public,
// host-neutral runtime. The current desktop product has no credential broker,
// so this adapter intentionally invokes only authorization-free Connectors.
type ImplementationHost struct {
	runtime   *implementationhost.Host
	artifacts PreparedArtifactResolver
}

func NewConnectorCommandRegistry() *ConnectorCommandRegistry {
	return &ConnectorCommandRegistry{runtime: implementationhost.NewCommandRegistry()}
}

func genericCLIArguments(raw any) ([]string, error) {
	return implementationhost.GenericCLIArguments(raw)
}

func NewImplementationHost(config ImplementationHostConfig) (*ImplementationHost, error) {
	if config.Commands == nil {
		return nil, errors.New("connector command registry is required")
	}
	if config.UserHome == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return nil, errors.New("connector implementation user home is unavailable")
		}
		config.UserHome = userHome
	}
	host, err := implementationhost.New(implementationhost.Config{
		Artifacts: config.Artifacts, CLIInstallations: config.CLIInstallations, Runtimes: config.Runtimes,
		Processes: config.Processes, Commands: config.Commands.runtime, StateRoot: config.StateRoot,
		UserHome:          config.UserHome,
		MCPStartupTimeout: config.MCPStartupTimeout,
	})
	if err != nil {
		return nil, err
	}
	return &ImplementationHost{runtime: host, artifacts: config.Artifacts}, nil
}

func (registry *ConnectorCommandRegistry) Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability {
	if registry == nil || registry.runtime == nil {
		return nil
	}
	capabilities := registry.runtime.Capabilities()
	result := make([]cliservice.Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		result = append(result, cliservice.Capability{ID: capability.ID, Path: append([]string(nil), capability.Path...),
			Summary: capability.Summary, Description: capability.Description, Visibility: cliservice.CapabilityVisibilityPublic,
			InputSchema: capability.InputSchema, Output: cliservice.CapabilityOutput{DefaultMode: cliservice.OutputModeJSON, JSON: true},
			Source: cliservice.CapabilitySource{Kind: cliservice.CapabilitySourceApp, AppID: capability.Source.AppID,
				AppName: capability.Source.AppName}})
	}
	return result
}

func (registry *ConnectorCommandRegistry) Invoke(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
	if registry == nil || registry.runtime == nil {
		return cliservice.CommandOutput{}, cliservice.ErrServiceUnavailable
	}
	output, err := registry.runtime.Invoke(ctx, command.InvokeRequest{CommandID: request.CommandID, Input: request.Input,
		Context: command.InvokeContext{Source: request.Context.Source, WorkspaceID: request.Context.WorkspaceID,
			AgentSessionID: request.Context.AgentSessionID, ParentCommandID: request.Context.ParentCommandID}})
	if err != nil {
		return cliservice.CommandOutput{}, serviceError(err)
	}
	return jsonValue(output.Value), nil
}

func (host *ImplementationHost) Reconcile(ctx context.Context, request market.RuntimeReconcileRequest) (market.RuntimeReceipt, error) {
	if host == nil || host.runtime == nil {
		return market.RuntimeReceipt{}, errors.New("connector implementation host is unavailable")
	}
	return host.runtime.Reconcile(ctx, implementationhost.ReconcileRequest{Runtime: request})
}

func (host *ImplementationHost) Begin(ctx context.Context, request market.AuthorizationStartRequest) (market.AuthorizationSession, error) {
	if host == nil || host.runtime == nil {
		return market.AuthorizationSession{}, errors.New("connector authorization provider is unavailable")
	}
	return host.runtime.BeginAuthorization(ctx, request)
}

func (host *ImplementationHost) Disconnect(ctx context.Context, request market.AuthorizationDisconnectRequest) error {
	if host == nil || host.runtime == nil {
		return errors.New("connector authorization provider is unavailable")
	}
	return host.runtime.DisconnectAuthorization(ctx, request)
}

func (host *ImplementationHost) DeactivateRuntime(ctx context.Context, request market.RuntimeDeactivationRequest) error {
	if host == nil || host.runtime == nil {
		return errors.New("connector implementation host is unavailable")
	}
	return host.runtime.DeactivateRuntime(ctx, request)
}

func (host *ImplementationHost) FailClosed(ctx context.Context, deadline time.Time) error {
	if host == nil || host.runtime == nil {
		return nil
	}
	return host.runtime.FailClosed(ctx, deadline)
}

func (host *ImplementationHost) FenceAll(ctx context.Context, deadline time.Time) error {
	if host == nil || host.runtime == nil {
		return nil
	}
	return host.runtime.FenceAll(ctx, deadline)
}

func (host *ImplementationHost) SetCapabilityPublication(enabled bool) {
	if host != nil && host.runtime != nil {
		host.runtime.SetCapabilityPublication(enabled)
	}
}

func (host *ImplementationHost) Close() error {
	if host == nil || host.runtime == nil {
		return nil
	}
	return host.runtime.Close()
}

func ProductionPorts(host *ImplementationHost) (market.ImplementationHost, market.AuthorizationProvider, market.CompatibilityEvaluator, market.ImplementationRegistry) {
	return host, host, productionCompatibility{}, market.NewImplementationRegistry(map[string]market.ImplementationValidator{
		market.ImplementationKindManagedStdio: nil,
	})
}

type productionCompatibility struct{}

func (productionCompatibility) Evaluate(manifest market.Manifest) market.Compatibility {
	if manifest.Implementation.Kind != market.ImplementationKindManagedStdio {
		return market.Compatibility{State: market.CompatibilityStateUnsupportedImplementation, Reason: "implementation or authorization broker is unavailable"}
	}
	if manifest.AuthorizationKind != "none" && (manifest.Implementation.ManagedStdio == nil || manifest.Implementation.ManagedStdio.CredentialBroker == nil) {
		return market.Compatibility{State: market.CompatibilityStateUnsupportedImplementation, Reason: "authorization broker is unavailable"}
	}
	for _, platform := range manifest.Compatibility.Platforms {
		if platform == runtime.GOOS+"-"+runtime.GOARCH {
			return market.Compatibility{State: market.CompatibilityStateSupported}
		}
	}
	if len(manifest.Compatibility.Platforms) != 0 {
		return market.Compatibility{State: market.CompatibilityStateUnsupportedPlatform, Reason: "platform is not supported"}
	}
	return market.Compatibility{State: market.CompatibilityStateSupported}
}
