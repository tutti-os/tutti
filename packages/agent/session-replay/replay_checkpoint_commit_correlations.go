package sessionreplay

import (
	"context"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func (s *Service) ObserveReplayCommitted(
	ctx context.Context,
	delta agenthost.CommittedDelta,
	replayContext ProviderObservationCommitContext,
) error {
	if s == nil || s.Workflow == nil || strings.TrimSpace(delta.TransactionID) == "" {
		return nil
	}
	batches := replayContext.Batches
	if len(batches) == 0 {
		return nil
	}
	workspaceID := replayCommittedWorkspaceID(delta)
	recordingID := strings.TrimSpace(replayContext.RecordingID)
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
	if err := ValidateProviderObservationCommitContext(
		replayContext,
	); err != nil {
		return ErrInvalidState
	}
	if err := s.ensureCheckpointRecorder(
		snapshot.Recording,
	); err != nil {
		return err
	}
	s.checkpoints.mu.Lock()
	defer s.checkpoints.mu.Unlock()
	for _, batch := range batches {
		position := ProviderUnitPosition{
			ConnectionID: batch.ConnectionID, ChunkSeq: batch.ChunkSeq,
			UnitIndex: batch.UnitIndex,
		}
		if snapshot.Recording.ID == s.checkpoints.recordingID {
			if err := s.materializeCommittedCandidatesLocked(
				ctx, snapshot, position, batch,
			); err != nil {
				return err
			}
		}
		entry, ok := s.checkpoints.pending[position]
		if !ok {
			continue
		}
		for index := range entry.Correlations {
			if entry.Correlations[index].Confirmed {
				continue
			}
			for _, event := range batch.Events {
				eventPosition := ProviderObservationPosition{
					ConnectionID: position.ConnectionID,
					ChunkSeq:     position.ChunkSeq,
					UnitIndex:    position.UnitIndex,
					EventIndex:   event.EventIndex,
				}
				addresses, found :=
					s.checkpoints.entities.providerAddressesForPlan(
						eventPosition,
						event,
						s.checkpoints.plan,
					)
				if !found || len(addresses) == 0 {
					continue
				}
				address := addresses[len(addresses)-1]
				if entry.Correlations[index].ID ==
					correlationID(position, event, address) &&
					committedObservationMatches(
						delta,
						entry.Correlations[index],
						event,
						address,
						eventPosition,
					) {
					entry.Correlations[index].Confirmed = true
					entry.Correlations[index].TransactionID = delta.TransactionID
					break
				}
			}
		}
		s.checkpoints.pending[position] = entry
		if err := s.Workflow.RecordCheckpointCandidate(
			ctx,
			snapshot.Recording.ID,
			entry,
			s.checkpoints.plan,
		); err != nil {
			return err
		}
	}
	return nil
}

func replayCommittedWorkspaceID(delta agenthost.CommittedDelta) string {
	if delta.ActivityState != nil {
		return strings.TrimSpace(delta.ActivityState.Input.WorkspaceID)
	}
	if delta.SessionMessages != nil {
		return strings.TrimSpace(delta.SessionMessages.Input.WorkspaceID)
	}
	return ""
}

// ObserveCommitted consumes lifecycle-only Host deltas. Provider observation
// correlations use ObserveReplayCommitted so Replay metadata never enters the
// Host contract.
func (s *Service) ObserveCommitted(
	ctx context.Context,
	delta agenthost.CommittedDelta,
) error {
	if s == nil || s.Workflow == nil ||
		delta.GoalOperation == nil ||
		strings.TrimSpace(delta.TransactionID) == "" {
		return nil
	}
	snapshot, active := s.Workflow.RecordingCursorSnapshot()
	if !active {
		return nil
	}
	if err := s.ensureCheckpointRecorder(snapshot.Recording); err != nil {
		return err
	}
	s.checkpoints.mu.Lock()
	defer s.checkpoints.mu.Unlock()
	return s.recordGoalCheckpointLocked(ctx, delta)
}

func (s *Service) materializeCommittedCandidatesLocked(
	ctx context.Context,
	snapshot RecordingCursorSnapshot,
	position ProviderUnitPosition,
	batch ProviderObservationBatch,
) error {
	existing, hasExisting := s.checkpoints.pending[position]
	seen := make(map[uint64]struct{}, len(existing.Observations))
	for _, observation := range existing.Observations {
		seen[observation.Position.EventIndex] = struct{}{}
	}
	missing := batch
	missing.Events = make([]ProviderObservationEvent, 0, len(batch.Events))
	for _, event := range batch.Events {
		if _, ok := seen[event.EventIndex]; !ok {
			missing.Events = append(missing.Events, event)
		}
	}
	if len(missing.Events) == 0 {
		return nil
	}
	entry, checkpoint, ok, err := s.checkpoints.buildCandidate(
		snapshot, position, missing,
	)
	if err != nil || !ok {
		return err
	}
	if hasExisting {
		entry = mergeCheckpointJournalEntry(existing, entry)
	}
	checkpointIndex := -1
	for index := len(s.checkpoints.plan.Checkpoints) - 1; index >= 0; index-- {
		trigger := s.checkpoints.plan.Checkpoints[index].Trigger
		if trigger.Source == CheckpointTriggerProviderObservation &&
			trigger.Position != nil &&
			trigger.Position.ConnectionID == position.ConnectionID &&
			trigger.Position.ChunkSeq == position.ChunkSeq &&
			trigger.Position.UnitIndex == position.UnitIndex {
			checkpointIndex = index
			break
		}
	}
	if checkpointIndex >= 0 {
		s.checkpoints.plan.Checkpoints[checkpointIndex] =
			MergeCheckpointCandidate(
				s.checkpoints.plan.Checkpoints[checkpointIndex],
				checkpoint,
			)
	} else {
		AppendCheckpoint(&s.checkpoints.plan, checkpoint)
	}
	s.checkpoints.pending[position] = entry
	return s.Workflow.RecordCheckpointCandidate(
		ctx,
		snapshot.Recording.ID,
		entry,
		s.checkpoints.plan,
	)
}

func (s *Service) recordGoalCheckpointLocked(
	ctx context.Context,
	delta agenthost.CommittedDelta,
) error {
	committed := delta.GoalOperation
	if committed == nil {
		return nil
	}
	kind, status, ok := goalCheckpointForCommitted(*committed)
	if !ok {
		return nil
	}
	snapshot, active := s.Workflow.RecordingCursorSnapshot()
	if !active || snapshot.ActivityEventSequence == 0 {
		return nil
	}
	sessionID := firstNonEmpty(
		committed.State.AgentSessionID,
		committed.Operation.AgentSessionID,
	)
	sessionID = strings.TrimSpace(sessionID)
	if _, ok := s.checkpoints.entities.sessionAddress(sessionID); !ok {
		return nil
	}
	for _, intent := range s.checkpoints.pendingActivityIntents {
		if intent.Type == "goal/controlRequested" &&
			strings.TrimSpace(intent.AgentSessionID) == sessionID {
			s.checkpoints.pendingGoals[sessionID] = *committed
			return nil
		}
	}
	goalAddress, ok := s.checkpoints.entities.byRuntime[goalRuntimeKey(sessionID)]
	if !ok {
		return nil
	}
	checkpoint := ReplayCheckpoint{
		Kind: kind, Tags: []string{kind},
		Cursor: ReplayCursor{
			ActivityEventSequence: snapshot.ActivityEventSequence,
			ProviderConnections:   s.checkpoints.connectionCursor(),
		},
		Trigger: CheckpointTrigger{
			Source:                     CheckpointTriggerActivityBoundary,
			AfterActivityEventSequence: snapshot.ActivityEventSequence,
			BoundaryKind:               ActivityBoundaryIntentEffects,
		},
		Subjects: []EntityAddress{goalAddress},
		Readiness: CheckpointReadiness{
			All: []ReadinessPredicate{{
				Type: "goal.status", Subject: 0, Equals: status,
			}},
		},
	}
	lastIndex := len(s.checkpoints.plan.Checkpoints) - 1
	if lastIndex >= 0 &&
		replayCursorsEqual(
			s.checkpoints.plan.Checkpoints[lastIndex].Cursor,
			checkpoint.Cursor,
		) {
		if containsString(
			s.checkpoints.plan.Checkpoints[lastIndex].Tags,
			kind,
		) {
			return nil
		}
		s.checkpoints.plan.Checkpoints[lastIndex] =
			MergeCheckpointCandidate(
				s.checkpoints.plan.Checkpoints[lastIndex],
				checkpoint,
			)
	} else {
		AppendCheckpoint(&s.checkpoints.plan, checkpoint)
	}
	return s.Workflow.RecordCheckpointPlan(
		ctx,
		snapshot.Recording.ID,
		s.checkpoints.plan,
	)
}

func goalCheckpointForCommitted(
	committed agenthost.GoalOperationCommitted,
) (kind, status string, ok bool) {
	switch committed.Stage {
	case agenthost.GoalOperationCompleted,
		agenthost.GoalOperationReconciled,
		agenthost.GoalOperationTerminal:
	default:
		return "", "", false
	}
	status = semanticGoalStatus(committed.State)
	switch status {
	case "running":
		return "goal.running", status, true
	case "paused":
		return "goal.paused", status, true
	case "completed":
		return "goal.completed", status, true
	case "cleared":
		return "goal.cleared", status, true
	default:
		return "", "", false
	}
}

func replayCursorsEqual(left, right ReplayCursor) bool {
	if left.ActivityEventSequence != right.ActivityEventSequence ||
		len(left.ProviderConnections) != len(right.ProviderConnections) {
		return false
	}
	for index := range left.ProviderConnections {
		if left.ProviderConnections[index] != right.ProviderConnections[index] {
			return false
		}
	}
	return true
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func stableObservationFields(event ProviderObservationEvent) map[string]any {
	stable := map[string]any{}
	for key, value := range map[string]string{
		"turnPhase": event.TurnPhase, "turnOutcome": event.TurnOutcome,
		"status": event.Status, "interactionKind": event.InteractionKind,
		"messageKind":         event.MessageKind,
		"sessionKind":         event.SessionKind,
		"noticeCommand":       event.NoticeCommand,
		"noticeCommandStatus": event.NoticeCommandStatus,
	} {
		if strings.TrimSpace(value) != "" {
			stable[key] = value
		}
	}
	if event.AttachmentCount > 0 {
		stable["attachmentCount"] = event.AttachmentCount
	}
	return stable
}

func correlationID(
	position ProviderUnitPosition,
	event ProviderObservationEvent,
	address EntityAddress,
) string {
	addressKey, _ := EntityAddressKey(address)
	return fmt.Sprintf("%s:%d:%d:%d:%s:%s:%s", position.ConnectionID,
		position.ChunkSeq, position.UnitIndex, event.EventIndex,
		event.Type, addressKey, correlationExpected(event))
}

func committedObservationMatches(
	delta agenthost.CommittedDelta,
	correlation CheckpointCommitCorrelation,
	event ProviderObservationEvent,
	address EntityAddress,
	position ProviderObservationPosition,
) bool {
	if !EntityAddressesEqual(correlation.Address, address) {
		return false
	}
	if correlation.ObservationPosition != position {
		return false
	}
	fingerprint, err := ObservationFingerprint(
		ProviderObservation{
			SchemaVersion: ObservationSchemaVersion,
			Type:          event.Type,
			Address:       address,
			Stable:        stableObservationFields(event),
		},
	)
	if err != nil || fingerprint != correlation.ObservationFingerprint {
		return false
	}
	switch correlation.Kind {
	case "session":
		if delta.ActivityState == nil {
			return false
		}
		session := delta.ActivityState.Result.State.Session
		return session.ID == event.AgentSessionID &&
			session.Kind == "child" &&
			session.RootAgentSessionID == event.RootAgentSessionID &&
			session.RootTurnID == event.RootTurnID &&
			session.ParentAgentSessionID == event.ParentAgentSessionID &&
			session.ParentTurnID == event.ParentTurnID &&
			session.ParentToolCallID == event.ParentToolCallID &&
			hasCommittedMutation(delta, "session", event.AgentSessionID)
	case "interaction":
		if delta.ActivityState == nil {
			return false
		}
		state := delta.ActivityState.Input.State
		transition := state.InteractionTransition
		expectedStatus := "pending"
		if event.Type == "interaction.superseded" {
			expectedStatus = "superseded"
		}
		return transition != nil &&
			transition.RequestID == event.InteractionID &&
			transition.TurnID == event.TurnID &&
			transition.Status == expectedStatus &&
			hasCommittedMutation(
				delta,
				"interaction",
				event.TurnID+"\x00"+event.InteractionID,
			)
	case "turn":
		if delta.ActivityState == nil {
			return false
		}
		state := delta.ActivityState.Input.State
		stateMatches := state.Turn != nil &&
			state.Turn.TurnID == event.TurnID &&
			semanticTurnStateMatches(
				state.Turn.Phase,
				state.Turn.Outcome,
				event.TurnPhase,
				event.TurnOutcome,
			)
		if root := state.RootProviderTurn; root != nil {
			stateMatches = stateMatches ||
				(root.RootTurnID == event.TurnID &&
					semanticRootProviderTurnMatches(
						root.Phase,
						root.Outcome,
						event.TurnPhase,
						event.TurnOutcome,
					))
		}
		if !stateMatches {
			return false
		}
		if hasCommittedMutation(delta, "turn", event.TurnID) {
			return true
		}
		// RootProviderTurnAccepted still means a durable turn-row write even when
		// ProjectionDirty was omitted (exact-replay session + already-running
		// canonical phase). Prefer the Result flag over inventing a dirty hint.
		result := delta.ActivityState.Result
		if (result.RootProviderTurnAccepted || result.RootTurnAccepted) &&
			strings.TrimSpace(result.RootTurn.TurnID) == event.TurnID {
			return true
		}
		// Claude Code acceptance may persist RootProviderTurn first; the
		// observation-bearing follow-up can then return the already-running
		// RootTurn with Accepted=false (no ProjectionDirty). Still confirm when
		// Result already shows the expected running turn.
		if event.Type == "root_provider_turn.started" {
			if strings.TrimSpace(result.RootTurn.TurnID) == event.TurnID &&
				semanticTurnStateMatches(
					result.RootTurn.Phase,
					result.RootTurn.Outcome,
					event.TurnPhase,
					event.TurnOutcome,
				) {
				return true
			}
			if strings.TrimSpace(result.Turn.TurnID) == event.TurnID &&
				semanticTurnStateMatches(
					result.Turn.Phase,
					result.Turn.Outcome,
					event.TurnPhase,
					event.TurnOutcome,
				) {
				return true
			}
		}
		return false
	case "call":
		if delta.SessionMessages == nil {
			return false
		}
		expectedStatus := firstNonEmpty(event.Status, strings.TrimPrefix(event.Type, "call."))
		for _, message := range delta.SessionMessages.Result.Messages {
			callID, _ := message.Payload["callId"].(string)
			status, _ := message.Payload["status"].(string)
			if message.TurnID == event.TurnID &&
				callID == event.CallID &&
				firstNonEmpty(status, message.Status) == expectedStatus {
				return hasCommittedMutation(delta, "message", message.MessageID)
			}
		}
		return false
	case "message":
		if delta.SessionMessages == nil {
			return false
		}
		for _, message := range delta.SessionMessages.Result.Messages {
			messageKind, _ := message.Payload["messageKind"].(string)
			if message.MessageID == event.MessageID &&
				message.TurnID == event.TurnID &&
				messageKind == event.MessageKind &&
				firstNonEmpty(message.Status, "completed") ==
					firstNonEmpty(event.Status, "completed") {
				if event.NoticeCommand != "" {
					command, _ := message.Payload["noticeCommand"].(string)
					status, _ := message.Payload["noticeCommandStatus"].(string)
					if command != event.NoticeCommand ||
						status != event.NoticeCommandStatus {
						continue
					}
				}
				if event.AttachmentCount > 0 &&
					canonicalAttachmentCount(message.Payload["content"]) !=
						event.AttachmentCount {
					continue
				}
				return hasCommittedMutation(delta, "message", message.MessageID)
			}
		}
		return false
	default:
		return false
	}
}

func semanticTurnStateMatches(
	phase, outcome, expectedPhase, expectedOutcome string,
) bool {
	// Activity-layer events still say "working"; the canonical store folds that
	// to "running". Match through the same vocabulary as readiness predicates
	// so Goal continuation turn.started correlations can confirm.
	phase = canonicalTurnPhase(phase)
	if expectedPhase = canonicalTurnPhase(expectedPhase); expectedPhase != "" &&
		phase != expectedPhase {
		return false
	}
	if expectedOutcome = strings.TrimSpace(expectedOutcome); expectedOutcome != "" &&
		strings.TrimSpace(outcome) != expectedOutcome {
		return false
	}
	return expectedPhase != "" || expectedOutcome != ""
}

func semanticRootProviderTurnMatches(
	phase, outcome, expectedPhase, expectedOutcome string,
) bool {
	expectedOutcome = strings.TrimSpace(expectedOutcome)
	if expectedOutcome != "" {
		return strings.TrimSpace(phase) == "completed" &&
			strings.TrimSpace(outcome) == expectedOutcome
	}
	expectedPhase = canonicalTurnPhase(expectedPhase)
	return canonicalTurnPhase(phase) == expectedPhase && expectedPhase != ""
}

func hasCommittedMutation(
	delta agenthost.CommittedDelta,
	kind, entityID string,
) bool {
	for _, mutation := range delta.ProjectionDirty {
		if mutation.EntityKind == kind && mutation.EntityID == entityID {
			return true
		}
	}
	return false
}

func correlationKind(event ProviderObservationEvent) string {
	if strings.HasPrefix(event.Type, "session.") {
		return "session"
	}
	if strings.HasPrefix(event.Type, "interaction.") {
		return "interaction"
	}
	if strings.HasPrefix(event.Type, "call.") {
		return "call"
	}
	if strings.HasPrefix(event.Type, "plan.") ||
		strings.HasPrefix(event.Type, "compaction.") ||
		strings.HasPrefix(event.Type, "attachment.") {
		return "message"
	}
	return "turn"
}

func canonicalAttachmentCount(value any) uint64 {
	var count uint64
	switch content := value.(type) {
	case []any:
		for _, item := range content {
			if block, ok := item.(map[string]any); ok {
				if id, _ := block["attachmentId"].(string); strings.TrimSpace(id) != "" {
					count++
				}
			}
		}
	case []map[string]any:
		for _, block := range content {
			if id, _ := block["attachmentId"].(string); strings.TrimSpace(id) != "" {
				count++
			}
		}
	}
	return count
}

func correlationExpected(event ProviderObservationEvent) string {
	switch event.Type {
	case "turn.completed", "turn.failed", "turn.canceled",
		"root_provider_turn.completed":
		return firstNonEmpty(event.TurnOutcome, event.Status, "completed")
	}
	return firstNonEmpty(event.Status, event.TurnPhase, event.TurnOutcome, event.Type)
}

func mergeCheckpointJournalEntry(
	left, right ObservationJournalEntry,
) ObservationJournalEntry {
	seen := make(map[string]struct{}, len(left.Correlations))
	for _, item := range left.Correlations {
		seen[item.ID] = struct{}{}
	}
	for _, item := range right.Correlations {
		if _, ok := seen[item.ID]; !ok {
			left.Correlations = append(left.Correlations, item)
		}
	}
	positions := make(map[ProviderObservationPosition]struct{}, len(left.Observations))
	for _, item := range left.Observations {
		positions[item.Position] = struct{}{}
	}
	for _, item := range right.Observations {
		if _, ok := positions[item.Position]; !ok {
			left.Observations = append(left.Observations, item)
		}
	}
	return left
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
