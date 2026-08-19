package connectormarket

import (
	"context"
	"errors"
	"os"
	"runtime"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
)

type PreparedArtifactResolver = implementationhost.PreparedArtifactResolver
type ConnectorRuntimeResolver = connectorruntime.ConnectorRuntimeResolver

type ConnectorRuntimeRegistry struct {
	runtime *implementationhost.RouteRegistry
	mcp     *implementationhost.MCPRegistry
}

type ImplementationHostConfig struct {
	Artifacts              PreparedArtifactResolver
	CLIInstallations       market.CLIInstallationManager
	Runtimes               ConnectorRuntimeResolver
	Processes              agentruntime.ProcessTransport
	Registry               *ConnectorRuntimeRegistry
	StateRoot              string
	BinDir                 string
	UserHome               string
	MCPStartupTimeout      time.Duration
	RemoteMCPClientFactory implementationhost.RemoteMCPClientFactory
}

// ImplementationHost adapts the host-neutral Connector runtime to tuttId.
type ImplementationHost struct {
	runtime   *implementationhost.Host
	artifacts PreparedArtifactResolver
}

func NewConnectorRuntimeRegistry() *ConnectorRuntimeRegistry {
	return &ConnectorRuntimeRegistry{runtime: implementationhost.NewRouteRegistry(), mcp: implementationhost.NewMCPRegistry()}
}

func (registry *ConnectorRuntimeRegistry) MCPRegistry() *implementationhost.MCPRegistry {
	if registry == nil {
		return nil
	}
	return registry.mcp
}

func (registry *ConnectorRuntimeRegistry) RouteRegistry() *implementationhost.RouteRegistry {
	if registry == nil {
		return nil
	}
	return registry.runtime
}

func NewImplementationHost(config ImplementationHostConfig) (*ImplementationHost, error) {
	if config.Registry == nil {
		return nil, errors.New("connector runtime registry is required")
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
		Processes: config.Processes, Registry: config.Registry.runtime, MCP: config.Registry.mcp, StateRoot: config.StateRoot, BinDir: config.BinDir,
		UserHome: config.UserHome, MCPStartupTimeout: config.MCPStartupTimeout,
		RemoteMCPClientFactory: config.RemoteMCPClientFactory,
	})
	if err != nil {
		return nil, err
	}
	return &ImplementationHost{runtime: host, artifacts: config.Artifacts}, nil
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

func (host *ImplementationHost) Cancel(ctx context.Context, request market.AuthorizationCancelRequest) error {
	if host == nil || host.runtime == nil {
		return errors.New("connector authorization provider is unavailable")
	}
	return host.runtime.CancelAuthorization(ctx, request)
}

func (host *ImplementationHost) InspectAuthorization(ctx context.Context, request market.AuthorizationInspectRequest) (market.AuthorizationObservation, error) {
	if host == nil || host.runtime == nil {
		return market.AuthorizationObservation{}, errors.New("connector authorization inspector is unavailable")
	}
	return host.runtime.InspectAuthorization(ctx, request)
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

func ProductionPorts(host *ImplementationHost, external market.AuthorizationProvider) (market.ImplementationHost, market.AuthorizationProvider, market.CompatibilityEvaluator, market.ImplementationRegistry) {
	return host, market.NewImplementationAuthorizationRouter(host, external), productionCompatibility{}, market.NewImplementationRegistry(map[string]market.ImplementationValidator{
		market.ImplementationKindManagedStdio:         nil,
		market.ImplementationKindRemoteStreamableHTTP: nil,
	})
}

type productionCompatibility struct{}

func (productionCompatibility) Evaluate(manifest market.Manifest) market.Compatibility {
	switch manifest.Implementation.Kind {
	case market.ImplementationKindRemoteStreamableHTTP:
		return market.Compatibility{State: market.CompatibilityStateSupported}
	case market.ImplementationKindManagedStdio:
	default:
		return market.Compatibility{State: market.CompatibilityStateUnsupportedImplementation, Reason: "implementation is unavailable"}
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
