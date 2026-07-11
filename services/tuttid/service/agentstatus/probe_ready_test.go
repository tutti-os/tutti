package agentstatus

import (
	"context"
	"runtime"
	"testing"
)

func TestDefaultProbeObservationCatchesDelayedStartupCrash(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell timing fixture")
	}
	service := Service{}
	result := service.probeCommandWithReadyAfter(
		context.Background(),
		ProbeResult{},
		[]string{"/bin/sh", "-c", "sleep 0.7; echo delayed-crash >&2; exit 7"},
		nil,
		service.probeReadyAfter(),
	)
	if result.Status != ProbeFailed || result.ReasonCode != "probe_exited" {
		t.Fatalf("probe = %#v, want delayed startup failure", result)
	}
}
