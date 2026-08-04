package sessionreplay

import (
	"context"
	"sort"
	"strings"
)

func (s *Service) ObserveProviderObservations(
	ctx context.Context,
	workspaceID, _ string,
	batches []ProviderObservationBatch,
) error {
	if s == nil || s.Workflow == nil || len(batches) == 0 {
		return nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	recordingID := strings.TrimSpace(batches[0].RecordingID)
	if recordingID == "" {
		if !s.Workflow.HasRecordingCaptureForScope(workspaceID) {
			return nil
		}
		return ErrInvalidState
	}
	snapshot, admitted :=
		s.Workflow.RecordingCursorSnapshotForCapture(recordingID)
	if !admitted || snapshot.Recording.ScopeID != workspaceID {
		return nil
	}
	for _, batch := range batches[1:] {
		if strings.TrimSpace(batch.RecordingID) != recordingID {
			return ErrInvalidState
		}
	}
	initialized := false
	for _, batch := range batches {
		if strings.TrimSpace(batch.RecordingID) != snapshot.Recording.ID {
			continue
		}
		if !initialized {
			if err := s.ensureCheckpointRecorder(snapshot.Recording); err != nil {
				return err
			}
			initialized = true
		}
		if err := s.recordProviderObservationBatch(
			ctx,
			snapshot,
			batch,
		); err != nil {
			return err
		}
	}
	return nil
}

// ObserveProviderInputUnit folds one handled Provider input unit into the
// recorder's handled lane. The recording transport reports every completed
// unit through this hook, so activity-boundary checkpoint cursors can cover
// units that changed canonical state without emitting checkpoint
// observations. It never creates checkpoint candidates.
func (s *Service) ObserveProviderInputUnit(
	recordingID string,
	position ProviderUnitPosition,
) {
	if s == nil {
		return
	}
	recordingID = strings.TrimSpace(recordingID)
	position.ConnectionID = strings.TrimSpace(position.ConnectionID)
	if recordingID == "" || position.ConnectionID == "" ||
		position.ChunkSeq == 0 || position.UnitIndex == 0 {
		return
	}
	s.checkpoints.mu.Lock()
	defer s.checkpoints.mu.Unlock()
	r := &s.checkpoints
	if r.recordingID != recordingID || r.handledUnits == nil {
		return
	}
	if current, seen := r.handledUnits[position.ConnectionID]; !seen ||
		providerUnitPositionAfter(position, current) {
		r.handledUnits[position.ConnectionID] = position
	}
}

func providerUnitPositionAfter(
	left, right ProviderUnitPosition,
) bool {
	return left.ChunkSeq > right.ChunkSeq ||
		(left.ChunkSeq == right.ChunkSeq && left.UnitIndex > right.UnitIndex)
}

func (s *Service) recordProviderObservationBatch(
	ctx context.Context,
	snapshot RecordingCursorSnapshot,
	batch ProviderObservationBatch,
) error {
	recordingID := strings.TrimSpace(batch.RecordingID)
	if recordingID == "" {
		return ErrInvalidState
	}
	if recordingID != snapshot.Recording.ID {
		return nil
	}
	position := ProviderUnitPosition{
		ConnectionID: strings.TrimSpace(batch.ConnectionID),
		ChunkSeq:     batch.ChunkSeq,
		UnitIndex:    batch.UnitIndex,
	}
	if position.ConnectionID == "" || position.ChunkSeq == 0 ||
		position.UnitIndex == 0 || len(batch.Events) == 0 {
		return nil
	}
	s.checkpoints.mu.Lock()
	defer s.checkpoints.mu.Unlock()
	r := &s.checkpoints
	if r.recordingID != snapshot.Recording.ID {
		return ErrInvalidState
	}
	r.connections[position.ConnectionID] = position
	r.backfillConnections()
	entry, checkpoint, ok, err := r.buildCandidate(
		snapshot,
		position,
		batch,
	)
	if err != nil || !ok {
		return err
	}
	if previous, exists := r.pending[position]; exists {
		entry = mergeCheckpointJournalEntry(previous, entry)
		r.plan.Checkpoints[len(r.plan.Checkpoints)-1] =
			MergeCheckpointCandidate(
				r.plan.Checkpoints[len(r.plan.Checkpoints)-1],
				checkpoint,
			)
	} else {
		AppendCheckpoint(&r.plan, checkpoint)
	}
	r.pending[position] = entry
	return s.Workflow.RecordCheckpointCandidate(
		ctx,
		snapshot.Recording.ID,
		entry,
		r.plan,
	)
}

func (r *checkpointRecorder) buildCandidate(
	snapshot RecordingCursorSnapshot,
	position ProviderUnitPosition,
	batch ProviderObservationBatch,
) (
	ObservationJournalEntry,
	ReplayCheckpoint,
	bool,
	error,
) {
	entry := ObservationJournalEntry{
		SchemaVersion: ObservationSchemaVersion,
		Position:      position,
		UnitKind:      ProviderInputUnitKind(batch.UnitKind),
		Observations:  []JournalObservation{},
		Correlations:  []CheckpointCommitCorrelation{},
	}
	var checkpoint ReplayCheckpoint
	found := false
	for _, event := range batch.Events {
		observationPosition := ProviderObservationPosition{
			ConnectionID: position.ConnectionID,
			ChunkSeq:     position.ChunkSeq,
			UnitIndex:    position.UnitIndex,
			EventIndex:   event.EventIndex,
		}
		addresses, ok := r.entities.providerAddressesForPlan(
			observationPosition,
			event,
			r.plan,
		)
		if !ok || len(addresses) == 0 {
			continue
		}
		readiness, kind, ok := describeProviderEvent(event)
		if !ok {
			continue
		}
		primary := addresses[len(addresses)-1]
		observation := ProviderObservation{
			SchemaVersion: ObservationSchemaVersion,
			Type:          event.Type,
			Address:       primary,
			Stable:        stableObservationFields(event),
		}
		fingerprint, err := ObservationFingerprint(observation)
		if err != nil {
			return entry, checkpoint, false, err
		}
		entry.Observations = append(
			entry.Observations,
			JournalObservation{
				Position:    observationPosition,
				Type:        event.Type,
				Fingerprint: fingerprint,
				Address:     primary,
			},
		)
		entry.Correlations = append(
			entry.Correlations,
			CheckpointCommitCorrelation{
				ID:                     correlationID(position, event, primary),
				Kind:                   correlationKind(event),
				Address:                primary,
				ObservationPosition:    observationPosition,
				ObservationFingerprint: fingerprint,
				Expected:               correlationExpected(event),
			},
		)
		predicates := make(
			[]ReadinessPredicate,
			0,
			len(addresses),
		)
		for index := range addresses {
			predicates = append(predicates, ReadinessPredicate{
				Type:    readiness.Type,
				Subject: index,
				Equals:  readiness.Equals,
			})
		}
		eventCheckpoint := ReplayCheckpoint{
			Kind: kind,
			Tags: []string{kind},
			Trigger: CheckpointTrigger{
				Source:      CheckpointTriggerProviderObservation,
				Position:    &observationPosition,
				UnitKind:    ProviderInputUnitKind(batch.UnitKind),
				Type:        event.Type,
				Fingerprint: fingerprint,
			},
			Subjects: addresses,
			Readiness: CheckpointReadiness{
				All: predicates,
			},
		}
		if !found {
			checkpoint = eventCheckpoint
			found = true
		} else {
			checkpoint = MergeCheckpointCandidate(
				checkpoint,
				eventCheckpoint,
			)
		}
	}
	if !found {
		return entry, checkpoint, false, nil
	}
	checkpoint.Cursor = ReplayCursor{
		ActivityEventSequence: max(
			snapshot.ActivityEventSequence,
			1,
		),
		ProviderConnections: r.connectionCursor(),
	}
	return entry, checkpoint, true, nil
}

func describeProviderEvent(
	event ProviderObservationEvent,
) (ReadinessPredicate, string, bool) {
	switch event.Type {
	case "interaction.requested":
		return ReadinessPredicate{
			Type: "interaction.status", Equals: "pending",
		}, "interaction.pending", true
	case "interaction.superseded":
		return ReadinessPredicate{
			Type: "interaction.status", Equals: "superseded",
		}, "interaction.superseded", true
	case "call.started":
		return ReadinessPredicate{
			Type: "call.status", Equals: "running",
		}, "tool.started", true
	case "call.completed":
		return ReadinessPredicate{
			Type: "call.status", Equals: "completed",
		}, "tool.completed", true
	case "call.failed":
		return ReadinessPredicate{
			Type: "call.status", Equals: "failed",
		}, "tool.completed", true
	case "plan.proposed":
		return ReadinessPredicate{
			Type: "plan.status", Equals: "completed",
		}, "plan.waiting", true
	case "compaction.updated":
		status := strings.TrimSpace(event.NoticeCommandStatus)
		if event.NoticeCommand != "compact" || status == "" {
			return ReadinessPredicate{}, "", false
		}
		kind := "compaction." + status
		switch status {
		case "running", "completed", "canceled":
		case "failed":
			kind = "compaction.completed"
		default:
			return ReadinessPredicate{}, "", false
		}
		return ReadinessPredicate{
			Type: "compaction.status", Equals: status,
		}, kind, true
	case "attachment.materialized":
		if event.AttachmentCount == 0 {
			return ReadinessPredicate{}, "", false
		}
		return ReadinessPredicate{
			Type: "attachment.materialized", Equals: "true",
		}, "attachment.materialized", true
	case "session.started", "session.updated":
		return ReadinessPredicate{
			Type: "child-session.status", Equals: "running",
		}, "child-session.running", true
	case "session.completed", "session.failed":
		return ReadinessPredicate{
			Type: "child-session.status", Equals: "completed",
		}, "child-session.completed", true
	case "turn.completed", "turn.failed", "turn.canceled",
		"root_provider_turn.completed":
		status := firstNonEmpty(
			event.TurnOutcome,
			event.Status,
			"completed",
		)
		kind := "turn.terminal"
		switch event.Type {
		case "turn.canceled":
			status = "canceled"
			kind = "turn.canceled"
		case "turn.failed":
			status = "failed"
		}
		return ReadinessPredicate{
			Type: "turn.status", Equals: status,
		}, kind, true
	case "turn.started", "turn.updated", "root_provider_turn.started":
		// Fold the observed activity-layer phase into the canonical store
		// vocabulary so replay readiness compares against canonical turns.
		return ReadinessPredicate{
			Type: "turn.phase",
			Equals: canonicalTurnPhase(firstNonEmpty(
				event.TurnPhase,
				"working",
			)),
		}, "turn.working", true
	default:
		return ReadinessPredicate{}, "", false
	}
}

func (r *checkpointRecorder) backfillConnections() {
	for index := range r.plan.Checkpoints {
		cursor := &r.plan.Checkpoints[index].Cursor
		existing := make(
			map[string]struct{},
			len(cursor.ProviderConnections),
		)
		for _, position := range cursor.ProviderConnections {
			existing[position.ConnectionID] = struct{}{}
		}
		for connectionID := range r.connections {
			if _, ok := existing[connectionID]; !ok {
				cursor.ProviderConnections = append(
					cursor.ProviderConnections,
					ProviderUnitPosition{
						ConnectionID: connectionID,
					},
				)
			}
		}
		sort.Slice(
			cursor.ProviderConnections,
			func(left, right int) bool {
				return cursor.ProviderConnections[left].ConnectionID <
					cursor.ProviderConnections[right].ConnectionID
			},
		)
	}
}

// activityBoundaryCursor is the provider cursor for activity-boundary
// checkpoints: the observation lane advanced to the handled lane wherever the
// daemon has already completed later units on an observed connection. The
// canonical state that made the activity effect succeed includes every
// handled unit, so the recorded cursor must too or replay readiness can
// never hold at the checkpoint (the canceled-compaction interrupt round trip
// is the known case). Connections that never carried an observation stay
// excluded so optional probe connections cannot enter checkpoint cursors.
func (r *checkpointRecorder) activityBoundaryCursor() []ProviderUnitPosition {
	cursor := r.connectionCursor()
	for index := range cursor {
		handled, ok := r.handledUnits[cursor[index].ConnectionID]
		if ok && providerUnitPositionAfter(handled, cursor[index]) {
			cursor[index] = handled
		}
	}
	return cursor
}

func (r *checkpointRecorder) connectionCursor() []ProviderUnitPosition {
	result := make(
		[]ProviderUnitPosition,
		0,
		len(r.connections),
	)
	for _, position := range r.connections {
		result = append(result, position)
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].ConnectionID < result[right].ConnectionID
	})
	return result
}
