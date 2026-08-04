package sessionreplay

import (
	"sync"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

type checkpointRecorder struct {
	mu sync.Mutex

	recordingID string
	plan        CheckpointPlan
	// connections is the observation lane: the last Provider unit position
	// that carried checkpoint observation events. Provider-observation
	// checkpoint cursors are derived from this lane only.
	connections map[string]ProviderUnitPosition
	// handledUnits is the handled lane: the last Provider input unit the
	// daemon completed per connection, reported synchronously by the
	// recording transport for every unit. Units that settle canonical state
	// without emitting checkpoint observation events (for example a canceled
	// compaction turn's interrupted completion) advance only this lane, so
	// activity-boundary cursors merge it to stay satisfiable at
	handledUnits           map[string]ProviderUnitPosition
	entities               replayEntityRegistry
	pending                map[ProviderUnitPosition]ObservationJournalEntry
	pendingActivityIntents map[string]ActivityEvent
	pendingGoals           map[string]agenthost.GoalOperationCommitted
	lastActivity           uint64
}

func (r *checkpointRecorder) reset(recording Recording) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.initializeLocked(recording)
}

func (r *checkpointRecorder) ensureInitialized(
	recording Recording,
	initialState []byte,
) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.recordingID == recording.ID {
		return nil
	}
	r.initializeLocked(recording)
	if err := r.entities.seedInitialState(initialState); err != nil {
		r.recordingID = ""
		return err
	}
	return nil
}

func (r *checkpointRecorder) initializeLocked(recording Recording) {
	r.recordingID = recording.ID
	r.plan = bootstrapCheckpointPlan()
	r.connections = make(map[string]ProviderUnitPosition)
	r.handledUnits = make(map[string]ProviderUnitPosition)
	r.entities = newReplayEntityRegistry(recording.RootAgentSessionID)
	r.pending = make(map[ProviderUnitPosition]ObservationJournalEntry)
	r.pendingActivityIntents = make(map[string]ActivityEvent)
	r.pendingGoals = make(map[string]agenthost.GoalOperationCommitted)
	r.lastActivity = 0
}

func bootstrapCheckpointPlan() CheckpointPlan {
	return NewCheckpointPlan([]ReplayCheckpoint{{
		ID:      "checkpoint-0000",
		Index:   0,
		Kind:    "replay.bootstrap",
		Tags:    []string{"replay.bootstrap"},
		Trigger: CheckpointTrigger{Source: CheckpointTriggerBootstrap},
		Readiness: CheckpointReadiness{
			All: []ReadinessPredicate{},
		},
	}})
}
