package agentsessionreplay

import (
	"context"
	"fmt"
	"strings"

	sessionreplay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func (r *SemanticRuntime) ObserveProviderObservations(
	_ context.Context,
	workspaceID, agentSessionID string,
	batches []sessionreplay.ProviderObservationBatch,
) error {
	if r == nil || strings.TrimSpace(workspaceID) != r.workspaceID {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cassetteID := r.cassetteForSession(agentSessionID, batches)
	if cassetteID == "" {
		return nil
	}
	state := r.observations[cassetteID]
	plan := r.plans[cassetteID]
	if state == nil || state.failure != nil {
		if state != nil {
			return state.failure
		}
		return nil
	}
	for _, batch := range batches {
		state.observeBatch(plan, batch)
		if state.failure != nil {
			return state.failure
		}
	}
	return nil
}

func (r *SemanticRuntime) cassetteForSession(
	agentSessionID string,
	batches []sessionreplay.ProviderObservationBatch,
) string {
	agentSessionID = strings.TrimSpace(agentSessionID)
	for cassetteID, registration := range r.registrations {
		if registration.RootSessionID == agentSessionID {
			return cassetteID
		}
		for _, batch := range batches {
			for _, event := range batch.Events {
				if registration.RootSessionID == firstNonEmpty(
					event.RootAgentSessionID,
					event.AgentSessionID,
				) {
					return cassetteID
				}
			}
		}
	}
	return ""
}

func (s *semanticObservationState) observeBatch(
	plan sessionreplay.CheckpointPlan,
	batch sessionreplay.ProviderObservationBatch,
) {
	position := sessionreplay.ProviderUnitPosition{
		ConnectionID: strings.TrimSpace(batch.ConnectionID),
		ChunkSeq:     batch.ChunkSeq,
		UnitIndex:    batch.UnitIndex,
	}
	if position.ConnectionID == "" || position.ChunkSeq == 0 ||
		position.UnitIndex == 0 {
		return
	}
	s.handled[position.ConnectionID] = position
	for _, event := range batch.Events {
		eventPosition := sessionreplay.ProviderObservationPosition{
			ConnectionID: position.ConnectionID,
			ChunkSeq:     position.ChunkSeq,
			UnitIndex:    position.UnitIndex,
			EventIndex:   event.EventIndex,
		}
		addresses, ok := s.projector.entities.providerAddressesForPlan(
			eventPosition,
			event,
			plan,
		)
		if !ok || len(addresses) == 0 {
			continue
		}
		address := addresses[len(addresses)-1]
		fingerprint, err := sessionreplay.ObservationFingerprint(
			sessionreplay.ProviderObservation{
				SchemaVersion: sessionreplay.ObservationSchemaVersion,
				Type:          event.Type,
				Address:       address,
				Stable:        stableObservationFields(event),
			},
		)
		if err != nil {
			s.failure = err
			return
		}
		for index, checkpoint := range plan.Checkpoints {
			trigger := checkpoint.Trigger
			if trigger.Source !=
				sessionreplay.CheckpointTriggerProviderObservation ||
				trigger.Position == nil ||
				*trigger.Position != eventPosition {
				continue
			}
			if trigger.UnitKind !=
				sessionreplay.ProviderInputUnitKind(batch.UnitKind) ||
				trigger.Type != event.Type ||
				trigger.Fingerprint != fingerprint {
				s.failure = fmt.Errorf(
					"checkpoint_trigger_mismatch: checkpoint %q",
					checkpoint.ID,
				)
				return
			}
			s.matched[index] = true
		}
	}
	for index, checkpoint := range plan.Checkpoints {
		trigger := checkpoint.Trigger
		if trigger.Source !=
			sessionreplay.CheckpointTriggerProviderObservation ||
			trigger.Position == nil ||
			trigger.Position.ConnectionID != position.ConnectionID ||
			trigger.Position.ChunkSeq != position.ChunkSeq ||
			trigger.Position.UnitIndex != position.UnitIndex ||
			s.matched[index] {
			continue
		}
		s.failure = fmt.Errorf(
			"checkpoint_trigger_missing: checkpoint %q",
			checkpoint.ID,
		)
		return
	}
}

func (*SemanticRuntime) flushPendingObservationBatches(
	_ context.Context,
	_ string,
) error {
	return nil
}

// NoteHandledProviderUnits folds transport-completed Provider input units into
// the semantic handled lane. Replay parks the input barrier after a unit is
// completed, so the runner can observe that the trigger unit was reached even
// when the observation stamp for that unit was lost (compact slash-command
// turn/started is the known case).
func (r *SemanticRuntime) NoteHandledProviderUnits(
	cassetteID string,
	handled map[string]sessionreplay.ProviderUnitPosition,
) {
	if r == nil || len(handled) == 0 {
		return
	}
	cassetteID = strings.TrimSpace(cassetteID)
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.observations[cassetteID]
	if state == nil || state.handled == nil {
		return
	}
	for connectionID, position := range handled {
		connectionID = strings.TrimSpace(connectionID)
		position.ConnectionID = strings.TrimSpace(position.ConnectionID)
		if connectionID == "" || position.ConnectionID == "" ||
			position.ChunkSeq == 0 || position.UnitIndex == 0 {
			continue
		}
		if position.ConnectionID != connectionID {
			position.ConnectionID = connectionID
		}
		current, seen := state.handled[connectionID]
		if !seen || providerUnitPositionAfter(position, current) {
			state.handled[connectionID] = position
		}
	}
}

func providerPositionPassed(
	handled map[string]sessionreplay.ProviderUnitPosition,
	position *sessionreplay.ProviderObservationPosition,
) bool {
	if position == nil {
		return false
	}
	current, ok := handled[position.ConnectionID]
	if !ok {
		return false
	}
	return current.ChunkSeq > position.ChunkSeq ||
		(current.ChunkSeq == position.ChunkSeq &&
			current.UnitIndex > position.UnitIndex)
}

func providerPositionReached(
	handled map[string]sessionreplay.ProviderUnitPosition,
	position *sessionreplay.ProviderObservationPosition,
) bool {
	if position == nil {
		return false
	}
	current, ok := handled[position.ConnectionID]
	if !ok {
		return false
	}
	return current.ChunkSeq > position.ChunkSeq ||
		(current.ChunkSeq == position.ChunkSeq &&
			current.UnitIndex >= position.UnitIndex)
}
