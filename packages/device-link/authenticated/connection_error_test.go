package authenticated

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestErrorPhaseFindsWrappedConnectError(t *testing.T) {
	root := errors.New("connectivity check failed")
	err := fmt.Errorf("establish peer: %w", &ConnectError{
		Phase: ConnectErrorPhaseConnectivity,
		Err:   root,
	})

	phase, ok := ErrorPhase(err)
	if !ok || phase != ConnectErrorPhaseConnectivity {
		t.Fatalf("ErrorPhase() = %q, %v; want %q, true", phase, ok, ConnectErrorPhaseConnectivity)
	}
	if !errors.Is(err, root) {
		t.Fatal("ConnectError does not unwrap its cause")
	}
}

func TestClassifyConnectFailurePreservesCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := classifyConnectFailure(
		ctx,
		ConnectErrorPhaseAuthenticatedTransport,
		errors.New("late transport failure"),
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("classifyConnectFailure() = %v; want context cancellation", err)
	}
	if _, ok := ErrorPhase(err); ok {
		t.Fatal("caller cancellation was classified as a path or transport failure")
	}
	phase, ok := FailurePhase(err)
	if !ok || phase != ConnectErrorPhaseAuthenticatedTransport {
		t.Fatalf("FailurePhase() = %q, %v; want %q, true", phase, ok, ConnectErrorPhaseAuthenticatedTransport)
	}
}

func TestClassifyConnectFailurePreservesCallerDeadlinePhase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 0)
	defer cancel()
	<-ctx.Done()

	err := classifyConnectFailure(
		ctx,
		ConnectErrorPhaseConnectivity,
		errors.New("late connectivity failure"),
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("classifyConnectFailure() = %v; want deadline exceeded", err)
	}
	if _, ok := ErrorPhase(err); ok {
		t.Fatal("caller deadline was classified as an ordinary connectivity failure")
	}
	phase, ok := FailurePhase(err)
	if !ok || phase != ConnectErrorPhaseConnectivity {
		t.Fatalf("FailurePhase() = %q, %v; want %q, true", phase, ok, ConnectErrorPhaseConnectivity)
	}
}
