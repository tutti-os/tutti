package mobileremote

import (
	"context"
	"sync"
)

// AttemptWake is the local rendezvous between the WebSocket hint lane and the
// authoritative HTTP attempt reader. Notifications are deliberately
// coalesced: a hint only says that the attempt should be fetched again.
type AttemptWake struct {
	mu      sync.Mutex
	version map[string]uint64
	waiters map[string]map[uint64]chan struct{}
	nextID  uint64
}

func NewAttemptWake() *AttemptWake {
	return &AttemptWake{
		version: make(map[string]uint64),
		waiters: make(map[string]map[uint64]chan struct{}),
	}
}

func (w *AttemptWake) Version(attemptID string) uint64 {
	if w == nil {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.version[attemptID]
}

func (w *AttemptWake) Notify(attemptID string) {
	if w == nil || attemptID == "" {
		return
	}
	w.mu.Lock()
	w.version[attemptID]++
	for _, waiter := range w.waiters[attemptID] {
		select {
		case waiter <- struct{}{}:
		default:
		}
	}
	w.mu.Unlock()
}

// Forget releases the version retained for an attempt after its worker has
// finished. Notifications are intentionally retained until then so a push
// racing worker creation cannot be lost between discovery and Wait.
func (w *AttemptWake) Forget(attemptID string) {
	if w == nil || attemptID == "" {
		return
	}
	w.mu.Lock()
	delete(w.version, attemptID)
	if len(w.waiters[attemptID]) == 0 {
		delete(w.waiters, attemptID)
	}
	w.mu.Unlock()
}

func (w *AttemptWake) Wait(ctx context.Context, attemptID string, after uint64) bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	if w.version[attemptID] > after {
		w.mu.Unlock()
		return true
	}
	w.nextID++
	waiterID := w.nextID
	waiter := make(chan struct{}, 1)
	if w.waiters[attemptID] == nil {
		w.waiters[attemptID] = make(map[uint64]chan struct{})
	}
	w.waiters[attemptID][waiterID] = waiter
	w.mu.Unlock()

	select {
	case <-waiter:
		w.removeWaiter(attemptID, waiterID)
		return true
	case <-ctx.Done():
		w.removeWaiter(attemptID, waiterID)
		return false
	}
}

func (w *AttemptWake) removeWaiter(attemptID string, waiterID uint64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	waiters := w.waiters[attemptID]
	delete(waiters, waiterID)
	if len(waiters) == 0 {
		delete(w.waiters, attemptID)
	}
}
