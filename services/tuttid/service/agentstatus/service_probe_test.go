package agentstatus

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestCodexProbeUsesDetectionCommandLimiter(t *testing.T) {
	limiter := NewDetectionCommandLimiter(1)
	release, acquired := limiter.acquire(context.Background())
	if !acquired {
		t.Fatal("failed to occupy detection command limiter")
	}
	defer release()

	var calls atomic.Int32
	service := Service{
		DetectionCommands: limiter,
		CodexProtocolProbe: func(context.Context, []string, []string) CodexProbeEvidence {
			calls.Add(1)
			return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	result := service.probeAdapterRuntimeCommand(ctx, ProviderSpec{
		Provider:       "codex",
		BinaryNames:    []string{"codex"},
		AdapterCommand: []string{"codex", "app-server"},
	}, providerRuntimeResolution{
		CLIPath:        "/tmp/codex",
		AdapterPath:    "/tmp/codex",
		AdapterCommand: []string{"codex", "app-server"},
	}, time.Now())

	if result.Status != ProbeFailed || result.ReasonCode != "probe_canceled" {
		t.Fatalf("result = %#v, want probe_canceled while limiter is occupied", result)
	}
	if calls.Load() != 0 {
		t.Fatalf("CodexProtocolProbe calls = %d, want 0 before limiter acquisition", calls.Load())
	}
}
