package agentextension

import (
	"testing"
	"time"
)

func TestRuntimeAdapterConfigAllowsBoundedAgentExtensionColdStart(t *testing.T) {
	t.Parallel()

	config := runtimeAdapterConfig(RuntimeBinding{}, "")
	if config.StartupTimeout != 60*time.Second {
		t.Fatalf("agent extension startup timeout = %s, want 60s", config.StartupTimeout)
	}
}
