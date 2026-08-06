package sessionreplay

import (
	"context"
	"strings"
)

func (s *Service) recordActivityBoundary(
	ctx context.Context,
	snapshot RecordingCursorSnapshot,
	events []ActivityEvent,
) error {
	if len(events) == 0 || snapshot.ActivityEventSequence == 0 {
		return nil
	}
	if err := s.ensureCheckpointRecorder(snapshot.Recording); err != nil {
		return err
	}
	s.checkpoints.mu.Lock()
	defer s.checkpoints.mu.Unlock()
	r := &s.checkpoints
	events = r.completeActivityBoundary(events)
	if len(events) == 0 {
		return nil
	}
	if err := r.bindActivityGoalIntroductions(events); err != nil {
		return err
	}
	// The activity stream is global, but completeActivityBoundary only inspects
	// this batch. A later complete batch must not cut the plan at a sequence
	// that still contains an earlier unresolved intent (cancelRequested /
	// submit/requested / …) — ValidateCheckpointPlan rejects that as
	// "activity trigger splits an intent from its effects".
	if len(r.pendingActivityIntents) > 0 {
		return nil
	}
	kind, subject, readiness, ok := r.describeActivityEvents(events)
	if sessionID := goalEffectSessionID(events); sessionID != "" {
		if committed, exists := r.pendingGoals[sessionID]; exists {
			if committedKind, status, committedOK :=
				goalCheckpointForCommitted(committed); committedOK {
				kind = committedKind
				subject, ok = r.goalAddressForActivity(
					sessionID,
					events,
				)
				readiness = ReadinessPredicate{
					Type: "goal.status", Equals: status,
				}
			}
			delete(r.pendingGoals, sessionID)
		}
	}
	if !ok {
		return nil
	}
	if snapshot.ActivityEventSequence <= r.lastActivity {
		return nil
	}
	boundaryKind := ActivityBoundarySingleEvent
	for _, event := range events {
		if event.Kind == ActivityEventKindIntent ||
			event.Kind == ActivityEventKindEffect {
			boundaryKind = ActivityBoundaryIntentEffects
		}
	}
	checkpoint := ReplayCheckpoint{
		Kind: kind, Tags: []string{kind},
		Cursor: ReplayCursor{
			ActivityEventSequence: snapshot.ActivityEventSequence,
			ProviderConnections:   r.activityBoundaryCursor(),
		},
		Trigger: CheckpointTrigger{
			Source:                     CheckpointTriggerActivityBoundary,
			AfterActivityEventSequence: snapshot.ActivityEventSequence,
			BoundaryKind:               boundaryKind,
		},
		Subjects: []EntityAddress{subject},
		Readiness: CheckpointReadiness{All: []ReadinessPredicate{{
			Type: readiness.Type, Subject: 0, Equals: readiness.Equals,
		}}},
	}
	if activityHasProjectBinding(events) {
		checkpoint = MergeCheckpointCandidate(
			checkpoint,
			ReplayCheckpoint{
				Kind:   "project.binding-ready",
				Tags:   []string{"project.binding-ready"},
				Cursor: checkpoint.Cursor,
				Trigger: CheckpointTrigger{
					Source:                     CheckpointTriggerActivityBoundary,
					AfterActivityEventSequence: snapshot.ActivityEventSequence,
					BoundaryKind:               boundaryKind,
				},
				Subjects: []EntityAddress{subject},
				Readiness: CheckpointReadiness{
					All: []ReadinessPredicate{{
						Type: "project.binding", Subject: 0,
						Equals: "recorded",
					}},
				},
			},
		)
	}
	AppendCheckpoint(&r.plan, checkpoint)
	r.lastActivity = snapshot.ActivityEventSequence
	return s.Workflow.RecordCheckpointPlan(ctx, snapshot.Recording.ID, r.plan)
}

func (r *checkpointRecorder) bindActivityGoalIntroductions(
	events []ActivityEvent,
) error {
	for _, event := range events {
		if event.Kind != ActivityEventKindEffect ||
			event.Type != "session/activate" {
			continue
		}
		outcome, _ := event.Payload["outcome"].(string)
		initialGoal, _ := event.Payload["initialGoalControl"].(map[string]any)
		if strings.TrimSpace(outcome) != "succeeded" || len(initialGoal) == 0 {
			continue
		}
		if _, ok := r.ensureGoalAddress(event.AgentSessionID, event.Sequence); !ok {
			return ErrInvalidState
		}
	}
	return nil
}

func activityHasProjectBinding(events []ActivityEvent) bool {
	for _, event := range events {
		if event.Kind != ActivityEventKindEffect ||
			event.Type != "session/activate" {
			continue
		}
		outcome, _ := event.Payload["outcome"].(string)
		railPlacement, _ := event.Payload["railPlacement"].(map[string]any)
		kind, _ := railPlacement["kind"].(string)
		if strings.TrimSpace(outcome) == "succeeded" &&
			strings.TrimSpace(kind) == "project" {
			return true
		}
	}
	return false
}

func goalEffectSessionID(events []ActivityEvent) string {
	for _, event := range events {
		if event.Kind == ActivityEventKindEffect &&
			event.Type == "goal/control" {
			return strings.TrimSpace(event.AgentSessionID)
		}
	}
	return ""
}

func (r *checkpointRecorder) completeActivityBoundary(
	events []ActivityEvent,
) []ActivityEvent {
	if r.pendingActivityIntents == nil {
		r.pendingActivityIntents = make(map[string]ActivityEvent)
	}
	result := append([]ActivityEvent(nil), events...)
	for _, event := range events {
		if event.Kind == ActivityEventKindIntent &&
			activityIntentRequiresEffect(event.Type) {
			r.pendingActivityIntents[event.EventID] = event
		}
	}
	for _, event := range events {
		if event.Kind != ActivityEventKindEffect {
			continue
		}
		intent, ok := r.pendingActivityIntents[event.CausedByEventID]
		if !ok {
			continue
		}
		if !activityEventsContainID(result, intent.EventID) {
			result = append([]ActivityEvent{intent}, result...)
		}
		delete(r.pendingActivityIntents, intent.EventID)
	}
	for _, event := range result {
		if event.Kind == ActivityEventKindIntent &&
			activityIntentRequiresEffect(event.Type) &&
			!activityEventsContainCause(result, event.EventID) {
			return nil
		}
	}
	return result
}

func activityIntentRequiresEffect(eventType string) bool {
	intent, ok := PortableActivityContract.IntentContract(eventType)
	if !ok {
		return false
	}
	if intent.RequiresEffect {
		return true
	}
	// Checkpoint cuts must not land between an intent and a later declared
	// effect — ValidateCheckpointPlan rejects that as splitting intent/effects.
	// The portable contract's requiresEffect flag is about timeline completeness,
	// which is weaker than this recorder constraint (e.g. stopRequested /
	// cancelRequested declare turn/cancel but set requiresEffect=false).
	return len(intent.Effects) > 0
}

func activityEventsContainID(events []ActivityEvent, eventID string) bool {
	for _, event := range events {
		if event.EventID == eventID {
			return true
		}
	}
	return false
}

func activityEventsContainCause(events []ActivityEvent, eventID string) bool {
	for _, event := range events {
		if event.Kind == ActivityEventKindEffect &&
			event.CausedByEventID == eventID {
			return true
		}
	}
	return false
}

func (r *checkpointRecorder) describeActivityEvents(
	events []ActivityEvent,
) (string, EntityAddress, ReadinessPredicate, bool) {
	for _, event := range events {
		if event.Type == "plan/feedbackRequested" {
			session, ok := r.entities.sessionAddress(
				event.AgentSessionID,
			)
			if !ok {
				return "", EntityAddress{},
					ReadinessPredicate{}, false
			}
			return "plan.feedback-submitted",
				session,
				ReadinessPredicate{
					Type: "session.status", Equals: "working",
				}, true
		}
	}
	if len(events) == 0 {
		return "", EntityAddress{}, ReadinessPredicate{}, false
	}
	return r.describeActivity(events[len(events)-1])
}

func (r *checkpointRecorder) describeActivity(
	event ActivityEvent,
) (string, EntityAddress, ReadinessPredicate, bool) {
	stringPayload := func(key string) string {
		value, _ := event.Payload[key].(string)
		return strings.TrimSpace(value)
	}
	sessionID := strings.TrimSpace(event.AgentSessionID)
	session, sessionOK := r.entities.sessionAddress(sessionID)
	switch event.Type {
	case "session/activate":
		if stringPayload("outcome") != "succeeded" {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		return "session.ready",
			session,
			ReadinessPredicate{
				Type: "session.exists", Equals: "true",
			}, true
	case "goal/control":
		if stringPayload("outcome") != "succeeded" {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		kind, status := goalCheckpointForAction(stringPayload("action"))
		if kind == "" {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		goal, ok := r.goalAddress(event)
		if !ok {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		return kind,
			goal,
			ReadinessPredicate{
				Type: "goal.status", Equals: status,
			}, true
	case "interactive.response", "interaction/respond":
		if event.Type == "interaction/respond" &&
			stringPayload("outcome") != "succeeded" {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		turnID := stringPayload("turnId")
		requestID := stringPayload("requestId")
		subject, ok := r.entities.interactionAddress(
			sessionID,
			turnID,
			"",
			requestID,
		)
		if !ok {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		return "interaction.resolved", subject,
			ReadinessPredicate{Type: "interaction.status", Equals: "answered"}, true
	case "turn.cancel", "turn/cancel":
		if event.Type == "turn/cancel" &&
			stringPayload("outcome") != "succeeded" {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		subject, ok := r.entities.turnAddress(
			sessionID,
			stringPayload("turnId"),
		)
		if !ok {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		return "turn.canceled", subject,
			ReadinessPredicate{Type: "turn.status", Equals: "canceled"}, true
	case "session.settings.update", "session/updateSettings":
		if event.Type == "session/updateSettings" &&
			stringPayload("outcome") != "succeeded" {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		return "settings.applied",
			session,
			ReadinessPredicate{Type: "settings.equal", Equals: "recorded"}, true
	case "session.send", "submit/requested":
		if !sessionOK {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		return "submission.accepted",
			session,
			ReadinessPredicate{Type: "session.status", Equals: "working"}, true
	case "plan.decision", "plan/submitDecision":
		if event.Type == "plan/submitDecision" &&
			stringPayload("outcome") != "succeeded" {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", EntityAddress{},
				ReadinessPredicate{}, false
		}
		return "plan.confirmed",
			session,
			ReadinessPredicate{
				Type:   "session.status",
				Equals: "working",
			}, true
	default:
		return "", EntityAddress{}, ReadinessPredicate{}, false
	}
}

func (r *checkpointRecorder) goalAddress(
	event ActivityEvent,
) (EntityAddress, bool) {
	sessionID := strings.TrimSpace(event.AgentSessionID)
	if sessionID == "" {
		sessionID = r.entities.rootSessionID
	}
	return r.ensureGoalAddress(sessionID, event.Sequence)
}

// ensureGoalAddress returns the Goal entity for a session, binding one to the
// Activity fact that introduced it.
func (r *checkpointRecorder) ensureGoalAddress(
	sessionID string,
	activitySequence uint64,
) (EntityAddress, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || activitySequence == 0 {
		return EntityAddress{}, false
	}
	key := goalRuntimeKey(sessionID)
	if existing, ok := r.entities.byRuntime[key]; ok {
		return existing, true
	}
	sessionAddress, ok := r.entities.sessionAddress(sessionID)
	if !ok {
		return EntityAddress{}, false
	}
	return r.entities.bind(
		key,
		replayActivityAddress(
			EntityKindGoal,
			activitySequence,
			entityParentDiscriminator(sessionAddress),
		),
		replayEntityBinding{
			SessionID: sessionID,
			EntityID:  sessionID,
		},
	)
}

func (r *checkpointRecorder) goalAddressForActivity(
	sessionID string,
	events []ActivityEvent,
) (EntityAddress, bool) {
	key := goalRuntimeKey(sessionID)
	if address, ok := r.entities.byRuntime[key]; ok {
		return address, true
	}
	for _, event := range events {
		if event.Type == "goal/controlRequested" ||
			event.Type == "goal/control" {
			return r.goalAddress(event)
		}
	}
	return EntityAddress{}, false
}

func goalCheckpointForAction(action string) (kind, status string) {
	switch strings.TrimSpace(action) {
	case "set", "resume":
		return "goal.running", "running"
	case "pause":
		return "goal.paused", "paused"
	case "clear":
		return "goal.cleared", "cleared"
	default:
		return "", ""
	}
}
