package agentruntime

import (
	"context"
	"errors"
	"testing"
	"time"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func TestReplayProviderInputBarrierHoldsConnectionsIndependently(t *testing.T) {
	t.Parallel()

	barrier := newReplayProviderInputBarrier()
	if err := barrier.setTargets([]sessionreplay.ProviderUnitPosition{
		{ConnectionID: "connection-1", ChunkSeq: 4, UnitIndex: 1},
		{ConnectionID: "connection-2", ChunkSeq: 9, UnitIndex: 2},
	}); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- barrier.complete(context.Background(), ProviderInputUnit{
			Position: sessionreplay.ProviderUnitPosition{
				ConnectionID: "connection-1", ChunkSeq: 4, UnitIndex: 1,
			},
		}, closed, nil)
	}()

	select {
	case err := <-firstDone:
		t.Fatalf("connection-1 was not held: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	if err := barrier.complete(context.Background(), ProviderInputUnit{
		Position: sessionreplay.ProviderUnitPosition{
			ConnectionID: "connection-2", ChunkSeq: 9, UnitIndex: 1,
		},
	}, closed, nil); err != nil {
		t.Fatalf("slower connection was blocked before target: %v", err)
	}
	barrier.clearTargets()
	select {
	case err := <-firstDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("connection-1 did not resume")
	}
}

func TestReplayProviderInputBarrierFailsClosedOnOvershoot(t *testing.T) {
	t.Parallel()

	barrier := newReplayProviderInputBarrier()
	if err := barrier.setTargets([]sessionreplay.ProviderUnitPosition{{
		ConnectionID: "connection-1", ChunkSeq: 4, UnitIndex: 1,
	}}); err != nil {
		t.Fatal(err)
	}
	err := barrier.complete(context.Background(), ProviderInputUnit{
		Position: sessionreplay.ProviderUnitPosition{
			ConnectionID: "connection-1", ChunkSeq: 4, UnitIndex: 2,
		},
	}, make(chan struct{}), nil)
	if !errors.Is(err, ErrReplayProviderOvershot) {
		t.Fatalf("overshoot error = %v", err)
	}
}

func TestReplayProviderInputBarrierFreezesProviderProgressTimeAtTargets(t *testing.T) {
	t.Parallel()

	barrier := newReplayProviderInputBarrier()
	first := sessionreplay.ProviderUnitPosition{
		ConnectionID: "connection-1", ChunkSeq: 4, UnitIndex: 1,
	}
	second := sessionreplay.ProviderUnitPosition{
		ConnectionID: "connection-1", ChunkSeq: 5, UnitIndex: 1,
	}
	if err := barrier.setTargets([]sessionreplay.ProviderUnitPosition{first}); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- barrier.complete(context.Background(), ProviderInputUnit{Position: first}, closed, nil)
	}()
	waitForReplayBarrierPosition(t, barrier, first)

	waitDone := make(chan error, 1)
	go func() {
		waitDone <- barrier.waitForProgressDuration(
			context.Background(), "connection-1", 30*time.Millisecond, closed,
		)
	}()
	select {
	case err := <-waitDone:
		t.Fatalf("provider progress time expired at first target: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	if err := barrier.setTargets([]sessionreplay.ProviderUnitPosition{second}); err != nil {
		t.Fatal(err)
	}
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- barrier.complete(context.Background(), ProviderInputUnit{Position: second}, closed, nil)
	}()
	waitForReplayBarrierPosition(t, barrier, second)
	select {
	case err := <-waitDone:
		t.Fatalf("provider progress time expired at second target: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	barrier.clearTargets()
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-waitDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("provider progress time did not resume")
	}
}

func waitForReplayBarrierPosition(
	t *testing.T,
	barrier *replayProviderInputBarrier,
	want sessionreplay.ProviderUnitPosition,
) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if got := barrier.state()[want.ConnectionID]; got == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("provider barrier did not reach %#v", want)
}
