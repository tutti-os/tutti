package candidateexchange

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/device-link/authenticated"
)

func TestActionPumpOwnsPublishRetryAndRemoteRefresh(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{
		LocalDebounce: time.Millisecond,
		PublishRetry:  time.Millisecond,
		RemotePoll:    time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	defer pump.Stop()
	pump.NotifyRemoteChange()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	remoteAttempts := 0
	var firstRemote Action
	var firstPublish Action
	for remoteAttempts < 2 || firstPublish.ID == 0 {
		action, nextErr := pump.Next(ctx)
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		switch action.Kind {
		case ActionRefreshRemote:
			remoteAttempts++
			outcome := ActionOutcome{Succeeded: true}
			if remoteAttempts == 1 {
				firstRemote = action
				outcome = ActionOutcome{Retryable: true}
			} else if action.ID == firstRemote.ID {
				t.Fatal("remote retry reused a completed action identity")
			}
			if _, err := pump.Resolve(action.ID, outcome); err != nil {
				t.Fatal(err)
			}
			if remoteAttempts == 1 {
				pump.NotifyRemoteChange()
			}
		case ActionPublishLocal:
			if len(action.Description.Candidates) == 0 {
				t.Fatal("publish action contains no candidate")
			}
			firstPublish = action
			if _, err := pump.Resolve(action.ID, ActionOutcome{Retryable: true}); err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatalf("unexpected action kind %q", action.Kind)
		}
	}

	retry, err := pump.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if retry.Kind != ActionPublishLocal || retry.ID == firstPublish.ID ||
		!slices.Equal(retry.Description.Candidates, firstPublish.Description.Candidates) {
		t.Fatalf("retry action = %+v, want a new action for exact snapshot %+v", retry, firstPublish)
	}
	if _, err := pump.Resolve(retry.ID, ActionOutcome{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
}

func TestActionPumpDoesNotSerializeLocalAndRemoteProductIO(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{
		LocalDebounce: time.Millisecond,
		RemotePoll:    time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	defer pump.Stop()
	pump.NotifyRemoteChange()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, err := pump.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Leave the first product I/O unresolved. The other Go worker must still be
	// able to issue its action instead of waiting behind a global action lock.
	second, err := pump.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.Kind == second.Kind {
		t.Fatalf("concurrent action kinds = %q and %q, want one per worker", first.Kind, second.Kind)
	}
	if _, err := pump.Resolve(first.ID, ActionOutcome{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := pump.Resolve(second.ID, ActionOutcome{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
}

func TestActionPumpTerminalOutcomeStopsAllWorkers(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	pump.NotifyRemoteChange()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var action Action
	for action.Kind != ActionRefreshRemote {
		action, err = pump.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if action.Kind == ActionPublishLocal {
			if _, err := pump.Resolve(action.ID, ActionOutcome{Succeeded: true}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := pump.Resolve(action.ID, ActionOutcome{Error: "identity changed"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pump.Next(ctx); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Next error = %v, want terminal action failure", err)
	}
	pump.Stop()
}

func TestActionPumpStopDoesNotDeliverNewActions(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	pump.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := pump.Next(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Next after Stop error = %v, want context cancellation", err)
	}
}

func TestActionPumpStopRejectsAnActionAlreadyWaitingForNext(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	pump.NotifyRemoteChange()
	deadline := time.Now().Add(time.Second)
	for {
		pump.mu.Lock()
		pending := len(pump.pending)
		pump.mu.Unlock()
		if pending != 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("candidate worker did not queue an action")
		}
		time.Sleep(time.Millisecond)
	}

	pump.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := pump.Next(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Next after waiting action was stopped = %v, want context cancellation", err)
	}
}

func TestActionPumpStopUnblocksConcurrentNext(t *testing.T) {
	t.Parallel()
	participant := newBlockedGatherParticipant(t)
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	nextDone := make(chan error, 1)
	go func() {
		_, nextErr := pump.Next(context.Background())
		nextDone <- nextErr
	}()
	deadline := time.Now().Add(time.Second)
	for {
		pump.mu.Lock()
		active := pump.activeNext
		pump.mu.Unlock()
		if active != 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Next did not start")
		}
		time.Sleep(time.Millisecond)
	}
	pump.Stop()
	select {
	case err := <-nextDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("concurrent Next error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("concurrent Next did not stop")
	}
}

func TestActionPumpResolveCannotStartAfterStop(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{RemotePoll: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	pump.NotifyRemoteChange()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var action Action
	for action.Kind != ActionRefreshRemote {
		action, err = pump.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if action.Kind == ActionPublishLocal {
			if _, err := pump.Resolve(action.ID, ActionOutcome{Succeeded: true}); err != nil {
				t.Fatal(err)
			}
		}
	}
	pump.Stop()
	if _, err := pump.Resolve(action.ID, ActionOutcome{
		Succeeded: true, RemoteCandidates: []string{"candidate:late"},
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Resolve after Stop error = %v, want context cancellation", err)
	}
}

func TestActionPumpStopWaitsForConcurrentResolve(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{
		LocalDebounce: time.Millisecond,
		RemotePoll:    time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	action, err := pump.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if action.Kind != ActionPublishLocal {
		t.Fatalf("first action kind = %q, want local publication", action.Kind)
	}

	exchange.publication.mu.Lock()
	resolveDone := make(chan error, 1)
	go func() {
		_, resolveErr := pump.Resolve(action.ID, ActionOutcome{Succeeded: true})
		resolveDone <- resolveErr
	}()
	deadline := time.Now().Add(time.Second)
	for {
		pump.mu.Lock()
		active := pump.activeResolve
		pump.mu.Unlock()
		if active != 0 {
			break
		}
		if time.Now().After(deadline) {
			exchange.publication.mu.Unlock()
			t.Fatal("Resolve did not enter its protected section")
		}
		time.Sleep(time.Millisecond)
	}
	stopDone := make(chan struct{})
	go func() {
		pump.Stop()
		close(stopDone)
	}()
	select {
	case <-stopDone:
		exchange.publication.mu.Unlock()
		t.Fatal("Stop returned before the active Resolve completed")
	case <-time.After(20 * time.Millisecond):
	}
	exchange.publication.mu.Unlock()
	select {
	case err := <-resolveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Resolve did not finish")
	}
	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("Stop did not finish after Resolve")
	}
}

func TestActionPumpCopiesPublishedActionDescription(t *testing.T) {
	t.Parallel()
	participant, err := authenticated.NewParticipant(authenticated.ParticipantConfig{IncludeLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer participant.Close()
	exchange, _, err := Start(participant, Config{
		LocalDebounce: time.Millisecond,
		PublishRetry:  time.Millisecond,
		RemotePoll:    time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	pump, err := NewActionPump(exchange)
	if err != nil {
		t.Fatal(err)
	}
	defer pump.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var first Action
	for first.Kind != ActionPublishLocal {
		first, err = pump.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
	}
	original := append([]string(nil), first.Description.Candidates...)
	first.Description.Candidates[0] = "mutated-by-product"
	if _, err := pump.Resolve(first.ID, ActionOutcome{Retryable: true}); err != nil {
		t.Fatal(err)
	}
	retry, err := pump.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if retry.Kind != ActionPublishLocal || !slices.Equal(retry.Description.Candidates, original) {
		t.Fatalf("retry action = %+v, want isolated candidates %#v", retry, original)
	}
	if _, err := pump.Resolve(retry.ID, ActionOutcome{Succeeded: true}); err != nil {
		t.Fatal(err)
	}
}
