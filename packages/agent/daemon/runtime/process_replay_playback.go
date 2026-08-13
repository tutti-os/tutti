package agentruntime

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"
)

const DefaultReplayPlaybackSpeed = 1

var (
	ErrReplayPlaybackUnavailable = errors.New("replay playback control is unavailable")
	ErrReplayPlaybackSpeed       = errors.New("unsupported replay playback speed")
	// errReplayRecvInterrupted wakes recvContext so pending synthetic optional-probe
	// responses can drain while inbound delivery is paused at a checkpoint.
	errReplayRecvInterrupted = errors.New("replay recv interrupted")
)

type ReplayPlaybackState struct {
	Speed             float64
	PlaybackElapsedMS float64
	Drained           bool
	Paused            bool
	FastForward       bool
}

type replayPlaybackController struct {
	mu                sync.Mutex
	speed             float64
	paused            bool
	fastForward       bool
	wallAnchor        time.Time
	playbackElapsedMS float64
	changed           chan struct{}
}

type replayPlaybackCursor struct {
	mu                         sync.Mutex
	controller                 *replayPlaybackController
	recordedAnchorMS           float64
	controllerPlaybackAnchorMS float64
}

func newReplayPlaybackController() *replayPlaybackController {
	return &replayPlaybackController{
		speed:      DefaultReplayPlaybackSpeed,
		wallAnchor: time.Now(),
		changed:    make(chan struct{}),
	}
}

func (c *replayPlaybackController) state() ReplayPlaybackState {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advanceClockLocked(time.Now())
	return ReplayPlaybackState{
		Speed:             c.speed,
		PlaybackElapsedMS: c.playbackElapsedMS,
		Paused:            c.paused,
		FastForward:       c.fastForward,
	}
}

func (c *replayPlaybackController) setSpeed(speed float64) error {
	if !isSupportedReplayPlaybackSpeed(speed) {
		return ErrReplayPlaybackSpeed
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advanceClockLocked(time.Now())
	if c.speed == speed {
		return nil
	}
	c.speed = speed
	c.signalChangedLocked()
	return nil
}

func (c *replayPlaybackController) setPaused(paused bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advanceClockLocked(time.Now())
	if c.paused == paused {
		return
	}
	c.paused = paused
	c.signalChangedLocked()
}

func (c *replayPlaybackController) setFastForward(fastForward bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advanceClockLocked(time.Now())
	if c.fastForward == fastForward {
		return
	}
	c.fastForward = fastForward
	c.signalChangedLocked()
}

func (c *replayPlaybackController) snapshot() (
	ReplayPlaybackState,
	float64,
	<-chan struct{},
) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.advanceClockLocked(time.Now())
	return ReplayPlaybackState{
		Speed:             c.speed,
		PlaybackElapsedMS: c.playbackElapsedMS,
		Paused:            c.paused,
		FastForward:       c.fastForward,
	}, c.playbackElapsedMS, c.changed
}

func (c *replayPlaybackController) signalChangedLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *replayPlaybackController) advanceClockLocked(now time.Time) {
	if !c.paused && !c.fastForward {
		c.playbackElapsedMS += float64(now.Sub(c.wallAnchor)) /
			float64(time.Millisecond) *
			c.speed
	}
	c.wallAnchor = now
}

func (c *replayPlaybackController) newCursor() *replayPlaybackCursor {
	_, playbackElapsedMS, _ := c.snapshot()
	return &replayPlaybackCursor{
		controller:                 c,
		controllerPlaybackAnchorMS: playbackElapsedMS,
	}
}

func (c *replayPlaybackCursor) waitUntil(
	ctx context.Context,
	targetElapsedMS int64,
	closed <-chan struct{},
	interrupt <-chan struct{},
) error {
	target := float64(targetElapsedMS)
	for {
		c.mu.Lock()
		state, playbackElapsedMS, changed := c.controller.snapshot()
		c.advanceToControllerTimeLocked(playbackElapsedMS)
		if state.Paused && !state.FastForward {
			c.mu.Unlock()
			if err := waitForReplayPlaybackChange(ctx, closed, changed, interrupt); err != nil {
				return err
			}
			continue
		}
		if state.FastForward {
			if target > c.recordedAnchorMS {
				c.recordedAnchorMS = target
			}
			c.mu.Unlock()
			return nil
		}
		remainingMS := target - c.recordedAnchorMS
		if remainingMS <= 0 {
			c.mu.Unlock()
			return nil
		}
		wait := time.Duration(math.Ceil(remainingMS/state.Speed)) * time.Millisecond
		c.mu.Unlock()
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			stopReplayPlaybackTimer(timer)
			return ctx.Err()
		case <-closed:
			stopReplayPlaybackTimer(timer)
			return context.Canceled
		case <-changed:
			stopReplayPlaybackTimer(timer)
		case <-interrupt:
			stopReplayPlaybackTimer(timer)
			return errReplayRecvInterrupted
		case <-timer.C:
		}
	}
}

func (c *replayPlaybackController) beginInboundRelease(
	ctx context.Context,
	closed <-chan struct{},
	interrupt <-chan struct{},
) (func(), error) {
	for {
		c.mu.Lock()
		if !c.paused || c.fastForward {
			return c.mu.Unlock, nil
		}
		changed := c.changed
		c.mu.Unlock()
		if err := waitForReplayPlaybackChange(ctx, closed, changed, interrupt); err != nil {
			return nil, err
		}
	}
}

func waitForReplayPlaybackChange(
	ctx context.Context,
	closed <-chan struct{},
	changed <-chan struct{},
	interrupt <-chan struct{},
) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-closed:
		return context.Canceled
	case <-changed:
		return nil
	case <-interrupt:
		return errReplayRecvInterrupted
	}
}

func (c *replayPlaybackCursor) advanceTo(targetElapsedMS int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, playbackElapsedMS, _ := c.controller.snapshot()
	c.advanceToControllerTimeLocked(playbackElapsedMS)
	if target := float64(targetElapsedMS); target > c.recordedAnchorMS {
		c.recordedAnchorMS = target
	}
}

func (c *replayPlaybackCursor) advanceToControllerTimeLocked(playbackElapsedMS float64) {
	if elapsed := playbackElapsedMS - c.controllerPlaybackAnchorMS; elapsed > 0 {
		c.recordedAnchorMS += elapsed
	}
	c.controllerPlaybackAnchorMS = playbackElapsedMS
}

func stopReplayPlaybackTimer(timer *time.Timer) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}

func isSupportedReplayPlaybackSpeed(speed float64) bool {
	switch speed {
	case 0.25, 0.5, 1, 2, 4:
		return true
	default:
		return false
	}
}
