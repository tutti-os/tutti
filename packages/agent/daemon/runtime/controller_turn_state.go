package agentruntime

import (
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func submittedTurnActivityEvents(session Session, turnID string, metadata TurnMetadata) []activityshared.Event {
	ctx, ok := activityEventContext(session, "turn-submitted:"+turnID, turnID)
	if !ok {
		return nil
	}
	event := activityshared.NewTurnUpdated(ctx, turnID, activityshared.TurnPhaseSubmitted)
	event.Payload.Metadata = map[string]any{"turnOrigin": "user_prompt"}
	// Inject turn lineage metadata so the Store persistence pipeline carries
	// parent_turn_id and relation into WorkspaceAgentTurnPatch → TurnTransition.
	if metadata.ParentTurnID != "" {
		event.Payload.Metadata["parentTurnId"] = metadata.ParentTurnID
	}
	if metadata.Relation != "" {
		event.Payload.Metadata["turnRelation"] = metadata.Relation
	}
	// The controller owns the submit moment; it publishes the submitted
	// lifecycle snapshot so downstream layers copy instead of recomputing
	// (ADR 0008).
	activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
		Origin:       activityshared.TurnLifecycleOriginController,
		ActiveTurnID: turnID,
		Phase:        string(activityshared.TurnPhaseSubmitted),
	})
	return []activityshared.Event{event}
}

// eventsCarryAdapterLifecycleSnapshot reports whether the batch contains an
// adapter-origin lifecycle snapshot — the signal that this session's provider
// publishes authoritative snapshots (ADR 0008).
func eventsCarryAdapterLifecycleSnapshot(events []activityshared.Event) bool {
	for _, event := range events {
		if snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event); ok &&
			snapshot.Origin == activityshared.TurnLifecycleOriginAdapter {
			return true
		}
	}
	return false
}

// applyTurnLifecycleSnapshots copies stamped lifecycle snapshots onto the
// session record. Consumers copy, never merge: the snapshot is the turn
// owner's full statement of the lifecycle at that moment.
func applyTurnLifecycleSnapshots(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
		if !ok {
			continue
		}
		session = applyTurnLifecycleSnapshot(session, snapshot, strings.TrimSpace(event.Payload.TurnID))
	}
	return session
}

func applyTurnLifecycleSnapshot(session Session, snapshot activityshared.TurnLifecycleSnapshot, eventTurnID string) Session {
	switch snapshot.Origin {
	case activityshared.TurnLifecycleOriginAdapter:
		// Snapshots reach the record over two channels (Exec emit closure and
		// the session event sink); drop anything older than what we applied.
		if snapshot.Seq != 0 && snapshot.Seq <= session.LifecycleSeq {
			return session
		}
		session.LifecycleSeq = snapshot.Seq
		session.LifecycleAuthority = true
	case activityshared.TurnLifecycleOriginController:
		// The controller only authors the submit moment and the settle
		// fallback; neither may clobber a different live provider turn.
		if session.TurnLifecycle != nil && session.TurnLifecycle.ActiveTurnID != nil {
			current := strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID)
			if runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase) &&
				current != "" &&
				current != strings.TrimSpace(snapshot.ActiveTurnID) &&
				current != eventTurnID {
				return session
			}
		}
	default:
		return session
	}
	lifecycle := TurnLifecycle{Phase: snapshot.Phase, Settling: snapshot.Settling}
	if turnID := strings.TrimSpace(snapshot.ActiveTurnID); turnID != "" {
		lifecycle.ActiveTurnID = &turnID
	}
	if outcome := strings.TrimSpace(snapshot.Outcome); outcome != "" {
		lifecycle.Outcome = &outcome
	}
	session.TurnLifecycle = &lifecycle
	return session
}

// sessionLevelStatusFromEvents extracts the genuinely session-scoped status
// signals from a batch: session failure/completion and explicit effective
// statuses. Unlike the legacy fold it never defaults an unknown or empty
// effective status to ready — for authority sessions readiness is derived
// from the lifecycle, not from metadata refreshes.
func sessionLevelStatusFromEvents(events []activityshared.Event) string {
	status := ""
	for _, event := range events {
		switch event.Type {
		case activityshared.EventSessionFailed:
			status = SessionStatusFailed
		case activityshared.EventSessionCompleted:
			status = SessionStatusCompleted
		case activityshared.EventSessionUpdated:
			switch strings.TrimSpace(event.Payload.EffectiveStatus) {
			case string(activityshared.SessionStatusWorking):
				status = SessionStatusWorking
			case string(activityshared.SessionStatusWaiting):
				status = SessionStatusWaiting
			case string(activityshared.SessionStatusCompleted):
				status = SessionStatusCompleted
			case string(activityshared.SessionStatusFailed):
				status = SessionStatusFailed
			case string(activityshared.SessionStatusPaused):
				status = SessionStatusCanceled
			}
		}
	}
	return status
}

// statusForAuthoritySession is THE status derivation for snapshot-authority
// sessions: a pure function of the copied lifecycle plus session-level
// signals. No other code path may write Status for these sessions.
func statusForAuthoritySession(session Session, batchSessionLevel string) string {
	if batchSessionLevel == SessionStatusFailed || batchSessionLevel == SessionStatusCompleted {
		return batchSessionLevel
	}
	lifecycle := session.TurnLifecycle
	if lifecycle != nil && runtimeTurnLifecyclePhaseIsLive(lifecycle.Phase) {
		if activityshared.TurnLifecyclePhaseIsWaiting(lifecycle.Phase) {
			return SessionStatusWaiting
		}
		return SessionStatusWorking
	}
	if lifecycle != nil && lifecycle.Phase == "settled" {
		if lifecycle.Outcome != nil {
			switch strings.TrimSpace(*lifecycle.Outcome) {
			case string(activityshared.TurnOutcomeFailed):
				return SessionStatusFailed
			case string(activityshared.TurnOutcomeInterrupted), "canceled":
				return SessionStatusCanceled
			}
		}
		return SessionStatusReady
	}
	if batchSessionLevel != "" {
		return batchSessionLevel
	}
	if current := strings.TrimSpace(session.Status); current != "" {
		return current
	}
	return SessionStatusReady
}

// submitAvailabilityForAuthoritySession derives SubmitAvailability from the
// same copied lifecycle, replacing the hand-written variants that used to
// live in the lifecycle fold, the reporter's codex patch path, and the
// reconcile.
func submitAvailabilityForAuthoritySession(session Session) *SubmitAvailability {
	lifecycle := session.TurnLifecycle
	if lifecycle != nil && runtimeTurnLifecyclePhaseIsLive(lifecycle.Phase) {
		if activityshared.TurnLifecyclePhaseIsWaiting(lifecycle.Phase) {
			return blockedSubmitAvailability("waiting")
		}
		return blockedSubmitAvailability("active_turn")
	}
	return availableSubmitAvailability()
}

// foldTurnSessionEvents applies an emitted turn event batch to the session
// record. Snapshot-authority sessions copy lifecycle snapshots and derive
// Status/SubmitAvailability purely (ADR 0008); legacy sessions keep the
// historic folding path until their provider publishes snapshots (Phase B).
func (c *Controller) foldTurnSessionEvents(session Session, events []activityshared.Event, execTurnID string) Session {
	events = eventsOwnedBySession(events, session.AgentSessionID)
	if len(events) == 0 {
		return session
	}
	previousStatus := session.Status
	if session.LifecycleAuthority || eventsCarryAdapterLifecycleSnapshot(events) {
		session = applySessionEventsBase(session, events)
		session = applyTurnLifecycleSnapshots(session, events)
		session.Status = statusForAuthoritySession(session, sessionLevelStatusFromEvents(events))
		session.SubmitAvailability = submitAvailabilityForAuthoritySession(session)
		return session
	}
	session = applySessionEvents(session, events)
	session = applyTurnLifecycleFromEvents(session, events)
	if turnEventsAreTerminal(events) {
		session = reconcileFinishedTurnStatus(session)
	} else if execTurnID != "" {
		session = c.preserveActiveTurnStatus(session, execTurnID, previousStatus)
	}
	return session
}

func eventsOwnedBySession(events []activityshared.Event, agentSessionID string) []activityshared.Event {
	agentSessionID = strings.TrimSpace(agentSessionID)
	owned := make([]activityshared.Event, 0, len(events))
	for _, event := range events {
		eventSessionID := strings.TrimSpace(event.AgentSessionID)
		if eventSessionID == "" || eventSessionID == agentSessionID {
			owned = append(owned, event)
		}
	}
	return owned
}

func applyTurnLifecycleFromEvents(session Session, events []activityshared.Event) Session {
	for _, event := range events {
		phase := turnLifecyclePhaseFromEvent(event)
		if phase == "" {
			continue
		}
		turnID := strings.TrimSpace(event.Payload.TurnID)
		if turnID == "" {
			continue
		}
		lifecycle := TurnLifecycle{Phase: phase}
		if phase == "settled" {
			outcome := turnLifecycleOutcomeFromEvent(event)
			if outcome != "" {
				lifecycle.Outcome = &outcome
			}
			session.SubmitAvailability = availableSubmitAvailability()
		} else {
			activeTurnID := turnID
			lifecycle.ActiveTurnID = &activeTurnID
			if phase == "waiting" {
				session.SubmitAvailability = blockedSubmitAvailability("waiting")
			} else {
				session.SubmitAvailability = blockedSubmitAvailability("active_turn")
			}
		}
		session.TurnLifecycle = &lifecycle
	}
	return session
}

func turnLifecyclePhaseFromEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnStarted, activityshared.EventRootProviderTurnStarted:
		return "running"
	case activityshared.EventTurnUpdated:
		switch strings.TrimSpace(event.Payload.TurnPhase) {
		case "submitted":
			return "submitted"
		case string(activityshared.TurnPhaseWaiting), string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
			return "waiting"
		case string(activityshared.TurnPhaseRunning), string(activityshared.TurnPhaseWorking):
			return "running"
		}
	case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
		return "settled"
	default:
		if string(event.Type) == EventTurnCanceled {
			return "settled"
		}
	}
	return ""
}

func turnLifecycleOutcomeFromEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnFailed:
		return "failed"
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return "canceled"
		}
		return "completed"
	default:
		if string(event.Type) == EventTurnCanceled {
			return "canceled"
		}
		return strings.TrimSpace(event.Payload.TurnOutcome)
	}
}

func cloneRuntimeSubmitAvailability(value *SubmitAvailability) *SubmitAvailability {
	if value == nil {
		return nil
	}
	return &SubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func cloneRuntimeCompletedCommand(value *CompletedCommand) *CompletedCommand {
	if value == nil {
		return nil
	}
	return &CompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func cloneRuntimeTurnLifecycle(value *TurnLifecycle) *TurnLifecycle {
	if value == nil {
		return nil
	}
	var activeTurnID *string
	if value.ActiveTurnID != nil {
		active := strings.TrimSpace(*value.ActiveTurnID)
		activeTurnID = &active
	}
	var outcome *string
	if value.Outcome != nil {
		next := strings.TrimSpace(*value.Outcome)
		outcome = &next
	}
	return &TurnLifecycle{
		ActiveTurnID:     activeTurnID,
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          outcome,
		CompletedCommand: cloneRuntimeCompletedCommand(value.CompletedCommand),
	}
}

func (c *Controller) preserveActiveTurnStatus(session Session, turnID string, previousStatus string) Session {
	if c == nil || session.Status != SessionStatusReady {
		return session
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	active, ok := c.turns[key]
	c.mu.Unlock()
	if ok && active.turnID == turnID {
		session.Status = firstNonEmpty(previousStatus, SessionStatusWorking)
	}
	return session
}

func (c *Controller) preserveCurrentSessionSettings(session Session) Session {
	if c == nil {
		return session
	}
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.preserveCurrentSessionSettingsLocked(key, session)
}

func (c *Controller) preserveCurrentSessionSettingsLocked(key string, session Session) Session {
	if c == nil {
		return session
	}
	current, ok := c.sessions[key]
	if !ok ||
		strings.TrimSpace(current.RoomID) != strings.TrimSpace(session.RoomID) ||
		strings.TrimSpace(current.AgentSessionID) != strings.TrimSpace(session.AgentSessionID) ||
		strings.TrimSpace(current.Provider) != strings.TrimSpace(session.Provider) {
		return session
	}
	session.PermissionModeID = strings.TrimSpace(current.PermissionModeID)
	if current.Settings != nil {
		settings := normalizeSessionSettings(current.Settings, current.Provider, session.PermissionModeID)
		session.Settings = cloneSessionSettings(settings)
	} else {
		session.Settings = nil
	}
	session.RuntimeContext = runtimeContextWithSessionSettings(session.RuntimeContext, session.SettingsValue())
	return session
}

func runtimeContextWithSessionSettings(runtimeContext map[string]any, settings SessionSettings) map[string]any {
	next := clonePayload(runtimeContext)
	if next == nil {
		next = map[string]any{}
	}
	next["permissionModeId"] = strings.TrimSpace(settings.PermissionModeID)
	next["planMode"] = settings.PlanMode
	next["model"] = strings.TrimSpace(settings.Model)
	next["reasoningEffort"] = strings.TrimSpace(settings.ReasoningEffort)
	next["speed"] = strings.TrimSpace(settings.Speed)
	return next
}

func sessionHasDifferentLiveTurn(session Session, turnID string) bool {
	if !sessionHasLiveTurnLifecycle(session) {
		return false
	}
	return runtimeTurnLifecycleActiveTurnID(session.TurnLifecycle) != strings.TrimSpace(turnID)
}

func settleFinishedTurnLifecycle(session Session, turnID string) Session {
	if session.TurnLifecycle == nil {
		return session
	}
	if runtimeTurnLifecycleActiveTurnID(session.TurnLifecycle) != strings.TrimSpace(turnID) {
		return session
	}
	if !runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase) {
		return session
	}
	outcome := "completed"
	if session.TurnLifecycle.Outcome != nil && strings.TrimSpace(*session.TurnLifecycle.Outcome) != "" {
		outcome = strings.TrimSpace(*session.TurnLifecycle.Outcome)
	}
	session.TurnLifecycle = &TurnLifecycle{
		Phase:            "settled",
		Outcome:          &outcome,
		CompletedCommand: cloneRuntimeCompletedCommand(session.TurnLifecycle.CompletedCommand),
	}
	session.SubmitAvailability = availableSubmitAvailability()
	return session
}

func sessionHasLiveTurnLifecycle(session Session) bool {
	if session.TurnLifecycle == nil {
		return false
	}
	return runtimeTurnLifecycleActiveTurnID(session.TurnLifecycle) != "" &&
		runtimeTurnLifecyclePhaseIsLive(session.TurnLifecycle.Phase)
}

func runtimeTurnLifecycleActiveTurnID(value *TurnLifecycle) string {
	if value == nil || value.ActiveTurnID == nil {
		return ""
	}
	return strings.TrimSpace(*value.ActiveTurnID)
}

func runtimeTurnLifecyclePhaseIsLive(phase string) bool {
	// Delegates to the canonical predicate; the phase vocabulary lives in
	// exactly one place (activityshared, mirrored in activity-core for TS).
	return activityshared.TurnLifecyclePhaseIsLive(phase)
}

func unemittedActivityEvents(events []activityshared.Event, emitted []activityshared.Event) []activityshared.Event {
	if len(events) == 0 {
		return nil
	}
	if len(emitted) == 0 {
		return events
	}
	seen := make(map[string]struct{}, len(emitted))
	for _, event := range emitted {
		seen[activityEventIdentity(event)] = struct{}{}
	}
	out := make([]activityshared.Event, 0, len(events))
	for _, event := range events {
		if _, ok := seen[activityEventIdentity(event)]; ok {
			continue
		}
		out = append(out, event)
	}
	return out
}

// retainTurnCallLifecycleEvents keeps adapter-produced close events for turnID
// when synthesizing a context-canceled terminal. Controllers must not discard:
//   - CallFailed closes for open tools
//   - failed/completed assistant or thinking snapshots that settle in-flight
//     stream rows (Claude FinishInterrupted on ctx cancel)
func retainTurnCallLifecycleEvents(events []activityshared.Event, turnID string) []activityshared.Event {
	turnID = strings.TrimSpace(turnID)
	if len(events) == 0 || turnID == "" {
		return nil
	}
	out := make([]activityshared.Event, 0, len(events))
	for _, event := range events {
		if strings.TrimSpace(event.Payload.TurnID) != turnID {
			continue
		}
		switch event.Type {
		case activityshared.EventCallStarted,
			activityshared.EventCallCompleted,
			activityshared.EventCallFailed:
			out = append(out, event)
		case activityshared.EventMessageAppended, activityshared.EventMessageCreated:
			if isRetainedCancelMessageSettlement(event) {
				out = append(out, event)
			}
		}
	}
	return out
}

func isRetainedCancelMessageSettlement(event activityshared.Event) bool {
	role := string(event.Payload.Role)
	if role != string(activityshared.MessageRoleAssistant) &&
		role != string(activityshared.MessageRoleAssistantThinking) {
		return false
	}
	streamState := asString(event.Payload.Metadata["streamState"])
	if streamState == "" {
		streamState = strings.TrimSpace(event.Payload.Status)
	}
	return streamState == messageStreamStateCompleted || streamState == messageStreamStateFailed
}

func activityEventIdentity(event activityshared.Event) string {
	if event.EventID != "" {
		return event.EventID
	}
	return fmt.Sprintf(
		"%s\x00%s\x00%s\x00%s\x00%d",
		event.Type,
		event.AgentSessionID,
		event.ProviderSessionID,
		event.Payload.TurnID,
		event.OccurredAtUnixMS,
	)
}
