//go:build !tuttid_integration_test && !tuttid_dev_edit_retry

package main

import (
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// Production binaries deliberately have no environment-controlled edit-retry
// enablement. The integration build supplies the dual-gated test fixture.
func enableEditRetrySagaForIntegration(
	host *agenthost.Host,
	_ agentservice.HostSupportPorts,
	_ agentservice.ApplicationHostCanonicalPorts,
	_ agenthost.SessionForkRecoveryStore,
	_ agenthost.HistoricalSessionStateStore,
	_ agentservice.ApplicationHostRuntime,
) *agenthost.Host {
	return host
}
