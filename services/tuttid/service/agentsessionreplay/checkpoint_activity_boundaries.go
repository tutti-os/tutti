package agentsessionreplay

import (
	"context"
	"strings"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

func (s *Service) recordActivityBoundary(
	ctx context.Context,
	snapshot replay.RecordingCursorSnapshot,
	events []replay.ActivityEvent,
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
				readiness = replay.ReadinessPredicate{
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
	boundaryKind := replay.ActivityBoundarySingleEvent
	for _, event := range events {
		if event.Kind == replay.ActivityEventKindIntent ||
			event.Kind == replay.ActivityEventKindEffect {
			boundaryKind = replay.ActivityBoundaryIntentEffects
		}
	}
	checkpoint := replay.ReplayCheckpoint{
		Kind: kind, Tags: []string{kind},
		Cursor: replay.ReplayCursor{
			ActivityEventSequence: snapshot.ActivityEventSequence,
			ProviderConnections:   r.activityBoundaryCursor(),
		},
		Trigger: replay.CheckpointTrigger{
			Source:                     replay.CheckpointTriggerActivityBoundary,
			AfterActivityEventSequence: snapshot.ActivityEventSequence,
			BoundaryKind:               boundaryKind,
		},
		Subjects: []replay.EntityAddress{subject},
		Readiness: replay.CheckpointReadiness{All: []replay.ReadinessPredicate{{
			Type: readiness.Type, Subject: 0, Equals: readiness.Equals,
		}}},
	}
	if activityHasProjectBinding(events) {
		checkpoint = replay.MergeCheckpointCandidate(
			checkpoint,
			replay.ReplayCheckpoint{
				Kind:   "project.binding-ready",
				Tags:   []string{"project.binding-ready"},
				Cursor: checkpoint.Cursor,
				Trigger: replay.CheckpointTrigger{
					Source:                     replay.CheckpointTriggerActivityBoundary,
					AfterActivityEventSequence: snapshot.ActivityEventSequence,
					BoundaryKind:               boundaryKind,
				},
				Subjects: []replay.EntityAddress{subject},
				Readiness: replay.CheckpointReadiness{
					All: []replay.ReadinessPredicate{{
						Type: "project.binding", Subject: 0,
						Equals: "recorded",
					}},
				},
			},
		)
	}
	replay.AppendCheckpoint(&r.plan, checkpoint)
	r.lastActivity = snapshot.ActivityEventSequence
	return s.Workflow.RecordCheckpointPlan(ctx, snapshot.Recording.ID, r.plan)
}

func activityHasProjectBinding(events []replay.ActivityEvent) bool {
	for _, event := range events {
		if event.Kind != replay.ActivityEventKindEffect ||
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

func goalEffectSessionID(events []replay.ActivityEvent) string {
	for _, event := range events {
		if event.Kind == replay.ActivityEventKindEffect &&
			event.Type == "goal/control" {
			return strings.TrimSpace(event.AgentSessionID)
		}
	}
	return ""
}

func (r *checkpointRecorder) completeActivityBoundary(
	events []replay.ActivityEvent,
) []replay.ActivityEvent {
	if r.pendingActivityIntents == nil {
		r.pendingActivityIntents = make(map[string]replay.ActivityEvent)
	}
	result := append([]replay.ActivityEvent(nil), events...)
	for _, event := range events {
		if event.Kind == replay.ActivityEventKindIntent &&
			activityIntentRequiresEffect(event.Type) {
			r.pendingActivityIntents[event.EventID] = event
		}
	}
	for _, event := range events {
		if event.Kind != replay.ActivityEventKindEffect {
			continue
		}
		intent, ok := r.pendingActivityIntents[event.CausedByEventID]
		if !ok {
			continue
		}
		if !activityEventsContainID(result, intent.EventID) {
			result = append([]replay.ActivityEvent{intent}, result...)
		}
		delete(r.pendingActivityIntents, intent.EventID)
	}
	for _, event := range result {
		if event.Kind == replay.ActivityEventKindIntent &&
			activityIntentRequiresEffect(event.Type) &&
			!activityEventsContainCause(result, event.EventID) {
			return nil
		}
	}
	return result
}

func activityIntentRequiresEffect(eventType string) bool {
	switch eventType {
	case "activation/requested", "goal/controlRequested",
		"interaction/responseRequested", "plan/decisionRequested",
		"plan/feedbackRequested", "session/cancelRequested",
		"session/settingsUpdateRequested", "submit/requested":
		// Keep submit/requested requiring an effect for checkpoint boundaries:
		// busy-queue admits have no immediate effect, but the same intent later
		// causes queue/sendPrompt on drain — cutting submission.accepted on the
		// bare intent fails checkpoint_plan validation (splits intent/effects).
		// Mid-queue UI evidence stays on record-time captureEvidence.
		return true
	default:
		return false
	}
}

func activityEventsContainID(events []replay.ActivityEvent, eventID string) bool {
	for _, event := range events {
		if event.EventID == eventID {
			return true
		}
	}
	return false
}

func activityEventsContainCause(events []replay.ActivityEvent, eventID string) bool {
	for _, event := range events {
		if event.Kind == replay.ActivityEventKindEffect &&
			event.CausedByEventID == eventID {
			return true
		}
	}
	return false
}

func (r *checkpointRecorder) describeActivityEvents(
	events []replay.ActivityEvent,
) (string, replay.EntityAddress, replay.ReadinessPredicate, bool) {
	for _, event := range events {
		if event.Type == "plan/feedbackRequested" {
			session, ok := r.entities.sessionAddress(
				event.AgentSessionID,
			)
			if !ok {
				return "", replay.EntityAddress{},
					replay.ReadinessPredicate{}, false
			}
			return "plan.feedback-submitted",
				session,
				replay.ReadinessPredicate{
					Type: "session.status", Equals: "working",
				}, true
		}
	}
	if len(events) == 0 {
		return "", replay.EntityAddress{}, replay.ReadinessPredicate{}, false
	}
	return r.describeActivity(events[len(events)-1])
}

func (r *checkpointRecorder) describeActivity(
	event replay.ActivityEvent,
) (string, replay.EntityAddress, replay.ReadinessPredicate, bool) {
	stringPayload := func(key string) string {
		value, _ := event.Payload[key].(string)
		return strings.TrimSpace(value)
	}
	sessionID := strings.TrimSpace(event.AgentSessionID)
	session, sessionOK := r.entities.sessionAddress(sessionID)
	switch event.Type {
	case "session/activate":
		if stringPayload("outcome") != "succeeded" {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		return "session.ready",
			session,
			replay.ReadinessPredicate{
				Type: "session.exists", Equals: "true",
			}, true
	case "goal/control":
		if stringPayload("outcome") != "succeeded" {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		kind, status := goalCheckpointForAction(stringPayload("action"))
		if kind == "" {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		goal, ok := r.goalAddress(event)
		if !ok {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		return kind,
			goal,
			replay.ReadinessPredicate{
				Type: "goal.status", Equals: status,
			}, true
	case "interactive.response", "interaction/respond":
		if event.Type == "interaction/respond" &&
			stringPayload("outcome") != "succeeded" {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
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
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		return "interaction.resolved", subject,
			replay.ReadinessPredicate{Type: "interaction.status", Equals: "answered"}, true
	case "turn.cancel", "turn/cancel":
		if event.Type == "turn/cancel" &&
			stringPayload("outcome") != "succeeded" {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		subject, ok := r.entities.turnAddress(
			sessionID,
			stringPayload("turnId"),
		)
		if !ok {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		return "turn.canceled", subject,
			replay.ReadinessPredicate{Type: "turn.status", Equals: "canceled"}, true
	case "session.settings.update", "session/updateSettings":
		if event.Type == "session/updateSettings" &&
			stringPayload("outcome") != "succeeded" {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		return "settings.applied",
			session,
			replay.ReadinessPredicate{Type: "settings.equal", Equals: "recorded"}, true
	case "session.send", "submit/requested":
		if !sessionOK {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		return "submission.accepted",
			session,
			replay.ReadinessPredicate{Type: "session.status", Equals: "working"}, true
	case "plan.decision", "plan/submitDecision":
		if event.Type == "plan/submitDecision" &&
			stringPayload("outcome") != "succeeded" {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		if !sessionOK {
			return "", replay.EntityAddress{},
				replay.ReadinessPredicate{}, false
		}
		return "plan.confirmed",
			session,
			replay.ReadinessPredicate{
				Type:   "session.status",
				Equals: "working",
			}, true
	default:
		return "", replay.EntityAddress{}, replay.ReadinessPredicate{}, false
	}
}

func (r *checkpointRecorder) goalAddress(
	event replay.ActivityEvent,
) (replay.EntityAddress, bool) {
	sessionID := strings.TrimSpace(event.AgentSessionID)
	if sessionID == "" {
		sessionID = r.entities.rootSessionID
	}
	if sessionID == "" || event.Sequence == 0 {
		return replay.EntityAddress{}, false
	}
	sessionAddress, ok := r.entities.sessionAddress(sessionID)
	if !ok {
		return replay.EntityAddress{}, false
	}
	key := goalRuntimeKey(sessionID)
	if existing, ok := r.entities.byRuntime[key]; ok {
		return existing, true
	}
	return r.entities.bind(
		key,
		activityAddress(
			replay.EntityKindGoal,
			event.Sequence,
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
	events []replay.ActivityEvent,
) (replay.EntityAddress, bool) {
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
	return replay.EntityAddress{}, false
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
