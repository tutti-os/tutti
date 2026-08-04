package main

import (
	"context"
	"fmt"

	agentdaemon "github.com/tutti-os/tutti/packages/agent/daemon"
	agenthostadapter "github.com/tutti-os/tutti/packages/agent/daemon/hostadapter"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentstoresqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// composeDaemonAgentHost keeps the agent lifecycle composition narrow: the
// production constructor admits V2 edit retry without an environment override;
// tagged integration wiring can substitute a test Host only through its hook.
func composeDaemonAgentHost(
	ctx context.Context,
	agentRuntime *agentdaemon.Runtime,
	runtimeController agentRuntimeAdapter,
	sessionConfig *agentservice.ServiceConfig,
	canonicalHostStore *agenthost.SQLiteWorkspaceStore,
	canonicalStore *agentstoresqlite.Store,
	historicalStateStore *agentstoresqlite.Store,
	activityProjection *agentservice.ActivityProjection,
	installAgentHost func(*agenthost.Host),
) (*agenthost.Host, *agentservice.ServiceComponents, func(), error) {
	if sessionConfig == nil || canonicalHostStore == nil || canonicalStore == nil ||
		historicalStateStore == nil || activityProjection == nil || agentRuntime == nil {
		return nil, nil, nil, fmt.Errorf("compose agent host: required dependency is unavailable")
	}
	agentHostRuntime, startupProviderCallsSettled := installStartupProviderCallTrap(
		&agenthostadapter.RuntimeController{Backend: agentRuntime.Controller()},
	)
	applyPostListenerRecoveryFailureInjection(sessionConfig)
	components := agentservice.NewServiceComponents(runtimeController, *sessionConfig, canonicalHostStore)
	hostSupport := components.HostSupportPorts()
	hostSupport.RuntimeOperationHealth = runtimeOperationHealthStoreForDaemon(canonicalHostStore)
	host := agentservice.NewApplicationHostWithPorts(
		hostSupport,
		canonicalHostStore,
		canonicalStore,
		historicalStateStore,
		agentHostRuntime,
	)
	host = enableEditRetrySagaForIntegration(
		host,
		hostSupport,
		canonicalHostStore,
		canonicalStore,
		historicalStateStore,
		agentHostRuntime,
	)
	if host == nil {
		return nil, nil, nil, fmt.Errorf("compose agent host")
	}
	if installAgentHost != nil {
		installAgentHost(host)
	}
	configureAgentProviderGoalAdoption(agentRuntime.Controller(), host)
	activityProjection.SetTurnForkabilityResolver(host)
	sessionConfig.Host = agentservice.ServiceHostConfig{ApplicationHost: host, Components: components}
	// Cold startup may repair only local durable invariants. Runtime operations
	// and provider work begin after listener publication; a poison operation
	// must never prevent the daemon from becoming reachable.
	if err := host.RecoverCore(ctx); err != nil {
		return nil, nil, nil, fmt.Errorf("recover agent host: %w", err)
	}
	return host, components, startupProviderCallsSettled, nil
}
