//go:build tuttid_integration_test

package agent

import agenthost "github.com/tutti-os/tutti/packages/agent/host"

// NewIntegrationApplicationHostWithEditRetryEnabled exists only in the
// test-tagged daemon binary. Production composition has no callable false
// feature path: NewApplicationHostWithPorts always passes true to the private
// composition helper.
func NewIntegrationApplicationHostWithEditRetryEnabled(
	support HostSupportPorts,
	canonical ApplicationHostCanonicalPorts,
	sessionForkRecovery agenthost.SessionForkRecoveryStore,
	historicalState agenthost.HistoricalSessionStateStore,
	runtime ApplicationHostRuntime,
) *agenthost.Host {
	if canonical == nil || runtime == nil || support.RuntimePreparation == nil {
		return nil
	}
	if support.RuntimeOperationHealth == nil {
		support.RuntimeOperationHealth = canonical
	}
	return composeApplicationHost(
		support,
		canonical,
		canonical,
		canonical,
		sessionForkRecovery,
		historicalState,
		runtime,
		runtime,
		agenthost.EditRetryAdmissionAllowNew,
		agenthost.EditRetryRecoveryDrain,
	)
}
