package agentextension

import (
	"context"
	"errors"
	"os"
	"testing"
)

func TestRuntimeExecutableIdentityCacheHonorsCanceledFingerprintContext(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cache := newRuntimeExecutableIdentityCache()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.load(ctx, executable); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled identity load error = %v", err)
	}
	if len(cache.entries) != 0 {
		t.Fatalf("canceled identity load cached %d entries", len(cache.entries))
	}
	if identity, err := cache.load(context.Background(), executable); err != nil || identity == nil {
		t.Fatalf("identity load after cancellation = %#v, error = %v", identity, err)
	}
}
