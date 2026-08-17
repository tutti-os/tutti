package agentruntime

import (
	"context"
	"errors"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type providerInputUnitTracker struct {
	mu        sync.Mutex
	nextToken uint64
	bySession map[string]*trackedProviderInputUnit
}

type trackedProviderInputUnit struct {
	token          uint64
	unit           ProviderInputUnit
	nextEventIndex uint64
}

type providerInputUnitError struct {
	err  error
	unit ProviderInputUnit
}

func (e providerInputUnitError) Error() string {
	return e.err.Error()
}

func (e providerInputUnitError) Unwrap() error {
	return e.err
}

func providerInputUnitFromError(err error) (ProviderInputUnit, bool) {
	var positioned providerInputUnitError
	if !errors.As(err, &positioned) {
		return ProviderInputUnit{}, false
	}
	return positioned.unit, true
}

func (t *providerInputUnitTracker) begin(
	ctx context.Context,
	agentSessionID string,
) func() {
	if t == nil {
		return func() {}
	}
	unit, ok := ProviderInputUnitFromContext(ctx)
	if !ok || agentSessionID == "" || unit.Position.ConnectionID == "" {
		return func() {}
	}
	t.mu.Lock()
	if t.bySession == nil {
		t.bySession = make(map[string]*trackedProviderInputUnit)
	}
	t.nextToken++
	token := t.nextToken
	t.bySession[agentSessionID] = &trackedProviderInputUnit{
		token: token,
		unit:  unit,
	}
	t.mu.Unlock()
	return func() {
		t.mu.Lock()
		if current := t.bySession[agentSessionID]; current != nil &&
			current.token == token {
			delete(t.bySession, agentSessionID)
		}
		t.mu.Unlock()
	}
}

func (t *providerInputUnitTracker) stamp(
	agentSessionID string,
	events []activityshared.Event,
) []activityshared.Event {
	if t == nil || len(events) == 0 {
		return events
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	current := t.bySession[agentSessionID]
	if current == nil {
		return events
	}
	for index := range events {
		// Message handlers may stamp a reduction before handing it to the
		// active-turn emitter. Keep the boundary idempotent so the same event
		// is never assigned two observation indexes while traversing both
		// paths.
		if events[index].ProviderInputUnit != nil {
			continue
		}
		current.nextEventIndex++
		events[index].ProviderInputUnit = &activityshared.ProviderInputUnitContext{
			RecordingID:  current.unit.RecordingID,
			ConnectionID: current.unit.Position.ConnectionID,
			ChunkSeq:     current.unit.Position.ChunkSeq,
			UnitIndex:    current.unit.Position.UnitIndex,
			EventIndex:   current.nextEventIndex,
			UnitKind:     string(current.unit.Kind),
		}
	}
	return events
}

func providerInputUnitTrackerForTransport(
	transport ProcessTransport,
) *providerInputUnitTracker {
	tracking, ok := transport.(ProviderInputUnitTrackingTransport)
	if !ok || !tracking.TracksProviderInputUnits() {
		return nil
	}
	return &providerInputUnitTracker{}
}

func stampProviderInputUnitFromError(
	err error,
	events []activityshared.Event,
) []activityshared.Event {
	unit, ok := providerInputUnitFromError(err)
	if !ok || len(events) == 0 {
		return events
	}
	for index := range events {
		events[index].ProviderInputUnit = &activityshared.ProviderInputUnitContext{
			RecordingID:  unit.RecordingID,
			ConnectionID: unit.Position.ConnectionID,
			ChunkSeq:     unit.Position.ChunkSeq,
			UnitIndex:    unit.Position.UnitIndex,
			EventIndex:   uint64(index + 1),
			UnitKind:     string(unit.Kind),
		}
	}
	return events
}
