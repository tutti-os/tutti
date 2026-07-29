package agent

import "testing"

func TestNativeProviderProbeChecksRequireRuntimeAndAuth(t *testing.T) {
	available := ProviderAvailability{Checks: []ProviderAvailabilityCheck{
		{Name: "cli", Passed: true},
		{Name: "adapter", Passed: true},
		{Name: "auth", Passed: true},
	}}
	if !nativeProviderProbeChecksPassed(available, "cli", "adapter", "auth") {
		t.Fatal("expected complete native provider checks to pass")
	}
	available.Checks[2].Passed = false
	if nativeProviderProbeChecksPassed(available, "cli", "adapter", "auth") {
		t.Fatal("expected missing provider authentication to stop the probe")
	}
}
