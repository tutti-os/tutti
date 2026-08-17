package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

var ErrReplayProviderOvershot = errors.New("checkpoint_provider_overshot")

// errReplaySyntheticPending tells the ACP read loop to drain pending synthetic
// optional-probe responses before retrying a checkpoint barrier wait.
var errReplaySyntheticPending = errors.New("replay synthetic response pending")

type replayProviderInputBarrier struct {
	mu      sync.Mutex
	active  bool
	targets map[string]sessionreplay.ProviderUnitPosition
	handled map[string]sessionreplay.ProviderUnitPosition
	changed chan struct{}
}

func newReplayProviderInputBarrier() *replayProviderInputBarrier {
	return &replayProviderInputBarrier{
		targets: map[string]sessionreplay.ProviderUnitPosition{},
		handled: map[string]sessionreplay.ProviderUnitPosition{},
		changed: make(chan struct{}),
	}
}

func (b *replayProviderInputBarrier) setTargets(
	targets []sessionreplay.ProviderUnitPosition,
) error {
	next := make(map[string]sessionreplay.ProviderUnitPosition, len(targets))
	for _, target := range targets {
		if target.ConnectionID == "" {
			return errors.New("replay provider target connection is empty")
		}
		if _, duplicate := next[target.ConnectionID]; duplicate {
			return fmt.Errorf("duplicate replay provider target %q", target.ConnectionID)
		}
		next[target.ConnectionID] = target
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for connectionID, handled := range b.handled {
		target, ok := next[connectionID]
		if !ok || compareReplayProviderPosition(handled, target) > 0 {
			return fmt.Errorf(
				"%w: connection %s already handled %d/%d",
				ErrReplayProviderOvershot,
				connectionID,
				handled.ChunkSeq,
				handled.UnitIndex,
			)
		}
	}
	b.active = true
	b.targets = next
	b.signalChangedLocked()
	return nil
}

func (b *replayProviderInputBarrier) clearTargets() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.active = false
	b.targets = map[string]sessionreplay.ProviderUnitPosition{}
	b.signalChangedLocked()
}

func (b *replayProviderInputBarrier) complete(
	ctx context.Context,
	unit ProviderInputUnit,
	closed <-chan struct{},
	interrupt <-chan struct{},
) error {
	for {
		b.mu.Lock()
		previous := b.handled[unit.Position.ConnectionID]
		if compareReplayProviderPosition(unit.Position, previous) < 0 {
			b.mu.Unlock()
			return fmt.Errorf(
				"%w: connection %s input position moved backward",
				ErrReplayProviderOvershot,
				unit.Position.ConnectionID,
			)
		}
		if compareReplayProviderPosition(unit.Position, previous) > 0 {
			b.handled[unit.Position.ConnectionID] = unit.Position
			b.signalChangedLocked()
		}
		if !b.active {
			b.mu.Unlock()
			return nil
		}
		target, ok := b.targets[unit.Position.ConnectionID]
		if !ok || compareReplayProviderPosition(unit.Position, target) > 0 {
			b.mu.Unlock()
			return fmt.Errorf(
				"%w: connection %s handled %d/%d past target",
				ErrReplayProviderOvershot,
				unit.Position.ConnectionID,
				unit.Position.ChunkSeq,
				unit.Position.UnitIndex,
			)
		}
		if compareReplayProviderPosition(unit.Position, target) < 0 {
			b.mu.Unlock()
			return nil
		}
		changed := b.changed
		b.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-closed:
			return context.Canceled
		case <-changed:
		case <-interrupt:
			return errReplaySyntheticPending
		}
	}
}

// waitForProgressDuration measures only time in which this connection can
// consume provider input. Checkpoint barriers deliberately stop that progress;
// wall-clock recovery timers must not expire while replay is parked there.
func (b *replayProviderInputBarrier) waitForProgressDuration(
	ctx context.Context,
	connectionID string,
	duration time.Duration,
	closed <-chan struct{},
) error {
	remaining := duration
	for remaining > 0 {
		b.mu.Lock()
		handled := b.handled[connectionID]
		target, targeted := b.targets[connectionID]
		blocked := b.active && targeted && compareReplayProviderPosition(handled, target) >= 0
		changed := b.changed
		b.mu.Unlock()

		if blocked {
			if err := waitForReplayPlaybackChange(ctx, closed, changed, nil); err != nil {
				return err
			}
			continue
		}

		started := time.Now()
		timer := time.NewTimer(remaining)
		select {
		case <-ctx.Done():
			stopReplayPlaybackTimer(timer)
			return ctx.Err()
		case <-closed:
			stopReplayPlaybackTimer(timer)
			return context.Canceled
		case <-changed:
			stopReplayPlaybackTimer(timer)
			remaining -= time.Since(started)
		case <-timer.C:
			return nil
		}
	}
	return nil
}

func (b *replayProviderInputBarrier) state() map[string]sessionreplay.ProviderUnitPosition {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := make(map[string]sessionreplay.ProviderUnitPosition, len(b.handled))
	for connectionID, position := range b.handled {
		result[connectionID] = position
	}
	return result
}

func (b *replayProviderInputBarrier) signalChangedLocked() {
	close(b.changed)
	b.changed = make(chan struct{})
}

func compareReplayProviderPosition(
	left, right sessionreplay.ProviderUnitPosition,
) int {
	if left.ChunkSeq < right.ChunkSeq {
		return -1
	}
	if left.ChunkSeq > right.ChunkSeq {
		return 1
	}
	if left.UnitIndex < right.UnitIndex {
		return -1
	}
	if left.UnitIndex > right.UnitIndex {
		return 1
	}
	return 0
}
