//go:build !tuttid_integration_test

package main

import agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
import agenthost "github.com/tutti-os/tutti/packages/agent/host"
import agenthostadapter "github.com/tutti-os/tutti/packages/agent/daemon/hostadapter"

// Production builds deliberately contain no environment-driven recovery
// fault injection. The integration-only implementation is selected solely by
// the tuttid_integration_test build tag.
func applyPostListenerRecoveryFailureInjection(*agentservice.ServiceConfig) {
}

// runtimeOperationHealthStoreForDaemon is intentionally a direct canonical
// reader in normal builds. The tagged integration variant alone decorates this
// read seam to model a health-query failure.
func runtimeOperationHealthStoreForDaemon(store agenthost.RuntimeOperationHealthStore) agenthost.RuntimeOperationHealthStore {
	return store
}

// installStartupProviderCallTrap has no production hook: the normal daemon
// passes the concrete runtime directly to Host. The tagged test variant wraps
// that same concrete adapter only to count calls.
func installStartupProviderCallTrap(runtime *agenthostadapter.RuntimeController) (agentservice.ApplicationHostRuntime, func()) {
	return runtime, func() {}
}
