package main

import (
	"path/filepath"

	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

// newAgentStatusService assembles the agent status service with its shared
// run-outcome store. The store is shared so a runtime auth failure (reporter
// side) surfaces in the status probe (List side) — see
// agentRunOutcomeReporter. Moved out of buildDaemonAPI to keep wiring.go
// within the file-length budget; construction is unchanged.
func newAgentStatusService(
	analyticsReporter reporterservice.Reporter,
	managedRuntimeResolver managedruntime.Resolver,
	agentRuntimeDir string,
) (agentstatusservice.Service, *agentstatusservice.RunOutcomeStore) {
	runOutcomes := agentstatusservice.NewRunOutcomeStore()
	return agentstatusservice.Service{
		AnalyticsReporter:    analyticsReporter,
		ManagedRuntime:       managedRuntimeResolver,
		ClaudeCodeRuntimeDir: filepath.Join(agentRuntimeDir, "claude-code"),
		RunOutcomes:          runOutcomes,
		StatusCache:          agentstatusservice.NewProviderStatusCache(),
		UpdateCache:          agentstatusservice.NewProviderUpdateCache(),
	}, runOutcomes
}
