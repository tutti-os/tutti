package agentsessionstore

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func (s *Store) InterruptWorkspaceAgents(ctx context.Context, roomID string, reason string) error {
	return s.interruptWorkspaceAgents(ctx, roomID, reason, nil)
}

func (s *Store) InterruptWorkspaceAgentSessions(ctx context.Context, roomID string, reason string, agentSessionIDs []string) error {
	targets := make(map[string]struct{}, len(agentSessionIDs))
	for _, agentSessionID := range agentSessionIDs {
		agentSessionID = strings.TrimSpace(agentSessionID)
		if agentSessionID != "" {
			targets[agentSessionID] = struct{}{}
		}
	}
	if len(targets) == 0 {
		return nil
	}
	return s.interruptWorkspaceAgents(ctx, roomID, reason, targets)
}

func (s *Store) interruptWorkspaceAgents(ctx context.Context, roomID string, _ string, targets map[string]struct{}) error {
	roomID = strings.TrimSpace(roomID)
	if s == nil || roomID == "" {
		return nil
	}
	entry := s.roomEntry(roomID)
	if entry == nil {
		return nil
	}

	now := time.Now().UnixMilli()
	patches := make([]WorkspaceAgentStatePatch, 0)
	patchOrigins := make([]string, 0)

	entry.mu.Lock()
	allowSingleSessionFallback := targets != nil && len(entry.state.Sessions) == 1
	matchedAgentTargets := make(map[string]struct{})
	providerTargetContexts := make(map[string]ProviderActivitySessionProjection)
	for index := range entry.state.Sessions {
		session := entry.state.Sessions[index]
		if targets != nil {
			if !matchesAgentSessionTarget(session, targets) && !allowSingleSessionFallback {
				continue
			}
			if _, ok := targets[strings.TrimSpace(session.AgentSessionID)]; ok {
				matchedAgentTargets[strings.TrimSpace(session.AgentSessionID)] = struct{}{}
			}
			if providerSessionID := strings.TrimSpace(session.ProviderSessionID); providerSessionID != "" {
				if _, ok := targets[providerSessionID]; ok {
					providerTargetContexts[providerSessionID] = session
				}
			}
		}
		if !isInterruptibleAgentSession(session, targets != nil) {
			continue
		}

		patches = append(patches, WorkspaceAgentStatePatch{
			AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
			AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			CWD:               strings.TrimSpace(session.CWD),
			LifecycleStatus:   string(activityshared.SessionStatusCompleted),
			CurrentPhase:      string(activityshared.TurnPhaseIdle),
			OccurredAtUnixMS:  now,
		})
		patchOrigins = append(patchOrigins, NormalizeSessionOrigin(session.SessionOrigin))

		session.LifecycleStatus = string(activityshared.SessionLifecycleStatusEnded)
		session.TurnPhase = string(activityshared.TurnPhaseIdle)
		session.EffectiveStatus = string(activityshared.SessionStatusCompleted)
		session.Status = string(activityshared.SessionStatusCompleted)
		session.EndedAtUnixMS = now
		session.UpdatedAtUnixMS = now
		entry.state.Sessions[index] = session
	}
	if targets != nil && len(providerTargetContexts) == 1 {
		var providerContext ProviderActivitySessionProjection
		var providerSessionID string
		for key, session := range providerTargetContexts {
			providerSessionID = key
			providerContext = session
		}
		for target := range targets {
			if target == providerSessionID {
				continue
			}
			if _, ok := matchedAgentTargets[target]; ok {
				continue
			}
			patches = append(patches, WorkspaceAgentStatePatch{
				AgentSessionID:    target,
				Provider:          strings.TrimSpace(providerContext.Provider),
				ProviderSessionID: providerSessionID,
				CWD:               strings.TrimSpace(providerContext.CWD),
				LifecycleStatus:   string(activityshared.SessionStatusCompleted),
				CurrentPhase:      string(activityshared.TurnPhaseIdle),
				OccurredAtUnixMS:  now,
			})
			patchOrigins = append(patchOrigins, WorkspaceAgentSessionOriginRuntime)
		}
	}
	entry.mu.Unlock()

	reporter, ok := s.client.(SessionActivityReporter)
	if !ok || reporter == nil {
		return nil
	}
	if len(patches) == 0 {
		return nil
	}
	type interruptReportPatch struct {
		patch  WorkspaceAgentStatePatch
		origin string
	}
	reportPatches := make([]interruptReportPatch, 0, len(patches))
	for index, patch := range patches {
		origin := ""
		if index < len(patchOrigins) {
			origin = patchOrigins[index]
		}
		if origin == "" {
			origin = WorkspaceAgentSessionOriginRuntime
		}
		reportPatches = append(reportPatches, interruptReportPatch{patch: patch, origin: origin})
	}
	sort.SliceStable(reportPatches, func(i, j int) bool {
		return interruptReportOriginRank(reportPatches[i].origin) < interruptReportOriginRank(reportPatches[j].origin)
	})
	for _, reportPatch := range reportPatches {
		patch := reportPatch.patch
		origin := reportPatch.origin
		_, err := ReportActivityAsSessionUpdates(ctx, reporter, ReportActivityInput{
			WorkspaceID: roomID,
			Source: EventSource{
				Provider:          strings.TrimSpace(patch.Provider),
				ProviderSessionID: strings.TrimSpace(patch.ProviderSessionID),
				AgentID:           strings.TrimSpace(patch.AgentSessionID),
				CWD:               strings.TrimSpace(patch.CWD),
				SessionOrigin:     origin,
			},
			StatePatches: []WorkspaceAgentStatePatch{patch},
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func statePatchFromActivityEvent(source EventSource, event activityshared.Event, sessionID string, timestamp int64) (WorkspaceAgentStatePatch, bool) {
	if !isAgentStatusEvent(event.Type) {
		return WorkspaceAgentStatePatch{}, false
	}
	patch := WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(sessionID),
		Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
		ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
		CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
		Title:             strings.TrimSpace(event.Payload.Title),
		LifecycleStatus:   strings.TrimSpace(event.Payload.LifecycleStatus),
		CurrentPhase:      firstNonEmptyString(event.Payload.TurnPhase, event.Payload.EffectiveStatus),
		LastError:         statePatchLastError(event),
		OccurredAtUnixMS:  timestamp,
	}
	if turnID := strings.TrimSpace(event.Payload.TurnID); turnID != "" {
		patch.Turn = &WorkspaceAgentTurnPatch{
			TurnID:  turnID,
			Phase:   strings.TrimSpace(event.Payload.TurnPhase),
			Outcome: strings.TrimSpace(event.Payload.TurnOutcome),
		}
	}
	applyExplicitTurnLifecycleToPatch(&patch, event)
	switch event.Type {
	case activityshared.EventSessionStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
	case activityshared.EventSessionCompleted:
		patch.LifecycleStatus = string(activityshared.SessionStatusCompleted)
		patch.CurrentPhase = string(activityshared.TurnPhaseIdle)
	case activityshared.EventSessionFailed:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusFailed))
		patch.CurrentPhase = string(activityshared.TurnPhaseFailed)
	case activityshared.EventTurnStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseWorking))
		if patch.Turn != nil {
			patch.Turn.StartedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnCompleted:
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnFailed:
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseFailed))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	}
	return patch, true
}

func statePatchLastError(event activityshared.Event) string {
	if event.Type != activityshared.EventSessionFailed && event.Type != activityshared.EventTurnFailed {
		return ""
	}
	return activityshared.BestEffortErrorMessage(event.Payload)
}

func applyExplicitTurnLifecycleToPatch(patch *WorkspaceAgentStatePatch, event activityshared.Event) {
	if patch == nil || !providerUsesExplicitTurnLifecycleProjection(patch.Provider) {
		return
	}
	turnID := strings.TrimSpace(event.Payload.TurnID)
	if turnID == "" {
		return
	}
	lifecyclePhase := explicitTurnLifecyclePhaseFromActivityEvent(event)
	if lifecyclePhase == "" {
		return
	}
	activeTurnID := turnID
	turnActive := &activeTurnID
	outcome := strings.TrimSpace(event.Payload.TurnOutcome)
	if lifecyclePhase == "settled" {
		turnActive = nil
		outcome = explicitTurnLifecycleOutcomeFromActivityEvent(event)
	}
	if patch.Turn == nil {
		patch.Turn = &WorkspaceAgentTurnPatch{TurnID: turnID}
	}
	patch.Turn.Phase = lifecyclePhase
	patch.Turn.ActiveTurnID = turnActive
	patch.Turn.Outcome = outcome
	patch.Turn.SubmitAvailability = submitAvailabilityForTurnLifecyclePhase(lifecyclePhase)
	if command := completedCommandFromEventMetadata(event.Payload.Metadata); command != nil {
		patch.Turn.CompletedCommand = command
	}
	patch.SubmitAvailability = cloneSubmitAvailability(patch.Turn.SubmitAvailability)
	patch.TurnLifecycle = &WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     turnActive,
		Phase:            lifecyclePhase,
		CompletedCommand: cloneCompletedCommand(patch.Turn.CompletedCommand),
	}
	if outcome != "" {
		patch.TurnLifecycle.Outcome = &outcome
	}
}

func providerUsesExplicitTurnLifecycleProjection(provider string) bool {
	resolved, ok := providerregistry.ResolveEventProvider(provider)
	if !ok {
		// No unmigrated provider used this projection in the activity store.
		// Their legacy projection path remains unchanged until their descriptor
		// migration declares an explicit policy.
		return false
	}
	return resolved.TurnLifecycleProjection == providerregistry.TurnLifecycleProjectionExplicit
}

func completedCommandFromEventMetadata(metadata map[string]any) *WorkspaceAgentCompletedCommand {
	kind := firstNonEmptyString(
		stringValueFromPayloadMap(metadata, "completedCommandKind"),
		stringValueFromPayloadMap(metadata, "noticeCommand"),
	)
	status := firstNonEmptyString(
		stringValueFromPayloadMap(metadata, "completedCommandStatus"),
		stringValueFromPayloadMap(metadata, "noticeCommandStatus"),
	)
	if kind == "" || status == "" {
		return nil
	}
	return &WorkspaceAgentCompletedCommand{
		Kind:   kind,
		Status: status,
	}
}

func explicitTurnLifecyclePhaseFromActivityEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnStarted:
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
	}
	return ""
}

func explicitTurnLifecycleOutcomeFromActivityEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnFailed:
		return "failed"
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return "canceled"
		}
		return "completed"
	default:
		return strings.TrimSpace(event.Payload.TurnOutcome)
	}
}

func submitAvailabilityForTurnLifecyclePhase(phase string) *WorkspaceAgentSubmitAvailability {
	// Classify the phase the same way reporter.go's
	// submitAvailabilityPatchForSnapshotPhase does. Hardcoding only
	// "submitted"/"running" missed the other live phases (working, streaming,
	// waiting_*): those fell through to nil, which drops SubmitAvailability from
	// the pushed state patch, so the GUI kept its previous "available" value
	// while a turn was actually running and let the user submit — the daemon
	// then rejected the send with "agent session already has an active turn".
	switch {
	case phase == "settled":
		return &WorkspaceAgentSubmitAvailability{State: "available"}
	case activityshared.TurnLifecyclePhaseIsWaiting(phase):
		return &WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "waiting"}
	case activityshared.TurnLifecyclePhaseIsLive(phase):
		return &WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "active_turn"}
	default:
		return nil
	}
}

func (s *Store) listRoomIDs() []string {
	if s == nil {
		return nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	roomIDs := make([]string, 0, len(s.rooms))
	for roomID := range s.rooms {
		roomIDs = append(roomIDs, roomID)
	}
	return roomIDs
}

func matchesAgentSessionTarget(session ProviderActivitySessionProjection, targets map[string]struct{}) bool {
	if len(targets) == 0 {
		return false
	}
	if _, ok := targets[strings.TrimSpace(session.AgentSessionID)]; ok {
		return true
	}
	if _, ok := targets[strings.TrimSpace(session.ProviderSessionID)]; ok {
		return true
	}
	return false
}

func isInterruptibleAgentSession(session ProviderActivitySessionProjection, explicitTarget bool) bool {
	switch strings.TrimSpace(session.EffectiveStatus) {
	case "working", "active", "waiting":
		return true
	}
	return explicitTarget && !isTerminalAgentSession(session)
}

func isTerminalAgentSession(session ProviderActivitySessionProjection) bool {
	switch normalizeSessionStatusToken(session.LifecycleStatus) {
	case "completed", "ended", "failed", "canceled":
		return true
	}
	switch normalizeSessionStatusToken(firstNonEmptyString(session.EffectiveStatus, session.Status)) {
	case "completed", "ended", "failed", "canceled":
		return true
	}
	return false
}

func interruptReportOriginRank(origin string) int {
	switch NormalizeSessionOrigin(origin) {
	case WorkspaceAgentSessionOriginRuntime:
		return 0
	default:
		return 1
	}
}

func (s *Store) markSessionIdle(roomID, agentSessionID string, updatedAtUnixMS int64) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	entry := s.roomEntry(roomID)
	if entry == nil || agentSessionID == "" {
		return
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	for index := range entry.state.Sessions {
		session := entry.state.Sessions[index]
		if strings.TrimSpace(session.AgentSessionID) != agentSessionID {
			continue
		}
		session.LifecycleStatus = string(activityshared.SessionLifecycleStatusActive)
		session.TurnPhase = string(activityshared.TurnPhaseIdle)
		session.EffectiveStatus = string(activityshared.SessionStatusIdle)
		if updatedAtUnixMS > 0 {
			session.UpdatedAtUnixMS = updatedAtUnixMS
		}
		entry.state.Sessions[index] = session
		return
	}
}

func (s *Store) updateActivitySyncState(
	roomID string,
	agentSessionID string,
	update func(*agentSessionSyncState, int64) WorkspaceAgentSyncState,
) (WorkspaceAgentSyncState, bool) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if s == nil || agentSessionID == "" || update == nil {
		return WorkspaceAgentSyncState{}, false
	}
	roomID = strings.TrimSpace(roomID)
	entry := s.roomEntry(roomID)
	if entry == nil {
		return WorkspaceAgentSyncState{}, false
	}

	entry.mu.Lock()
	if isHiddenAgentSession(entry, agentSessionID) {
		entry.mu.Unlock()
		return WorkspaceAgentSyncState{}, false
	}
	if entry.syncStates == nil {
		entry.syncStates = make(map[string]*agentSessionSyncState)
	}
	current := entry.syncStates[agentSessionID]
	if current == nil {
		current = &agentSessionSyncState{
			state: WorkspaceAgentSyncState{AgentSessionID: agentSessionID},
		}
		entry.syncStates[agentSessionID] = current
	}
	next := update(current, time.Now().UnixMilli())
	current.state = next
	// Persist while holding entry.mu so sync-state writes serialize with
	// HideAgentSession's delete (also under entry.mu): a save must never land
	// after the delete and resurrect a hidden session's sync state.
	s.saveSyncState(roomID, next)
	entry.mu.Unlock()
	s.notifyRoomUpdate(roomID)
	return next, true
}

func (s *Store) loadStoredSyncStates(roomID string) map[string]WorkspaceAgentSyncState {
	if s == nil || s.syncStateStore == nil {
		return nil
	}
	states, err := s.syncStateStore.LoadRoomSyncStates(context.Background(), roomID)
	if err != nil {
		slog.Warn("agent activity sync state load failed",
			"event", "agent_activity.sync_state.load_failed",
			"room_id", strings.TrimSpace(roomID),
			"error", err,
		)
		return nil
	}
	return states
}

func (s *Store) loadStoredMessageCursors(roomID string) map[string]uint64 {
	if s == nil || s.messageCursorStore == nil {
		return nil
	}
	cursors, err := s.messageCursorStore.LoadRoomMessageCursors(context.Background(), roomID)
	if err != nil {
		slog.Warn("agent activity message cursor load failed",
			"event", "agent_activity.message_cursor.load_failed",
			"room_id", strings.TrimSpace(roomID),
			"error", err,
		)
		return nil
	}
	return cursors
}

func (s *Store) saveMessageCursor(roomID, agentSessionID string, version uint64) {
	if s == nil || s.messageCursorStore == nil {
		return
	}
	if err := s.messageCursorStore.SaveMessageCursor(context.Background(), roomID, agentSessionID, version); err != nil {
		slog.Warn("agent activity message cursor save failed",
			"event", "agent_activity.message_cursor.save_failed",
			"room_id", strings.TrimSpace(roomID),
			"agent_session_id", strings.TrimSpace(agentSessionID),
			"error", err,
		)
	}
}

func (s *Store) saveSyncState(roomID string, syncState WorkspaceAgentSyncState) {
	if s == nil || s.syncStateStore == nil {
		return
	}
	if err := s.syncStateStore.SaveAgentSyncState(context.Background(), roomID, syncState); err != nil {
		slog.Warn("agent activity sync state save failed",
			"event", "agent_activity.sync_state.save_failed",
			"room_id", strings.TrimSpace(roomID),
			"agent_session_id", strings.TrimSpace(syncState.AgentSessionID),
			"error", err,
		)
	}
}

func applyActivitySyncPending(
	current *agentSessionSyncState,
	agentSessionID string,
	timelineItemCount int,
	statePatchCount int,
	messageUpdateCount int,
	now int64,
) WorkspaceAgentSyncState {
	current.pendingReports++
	current.state.AgentSessionID = strings.TrimSpace(agentSessionID)
	current.state.Status = WorkspaceAgentSyncStatusPending
	current.state.PendingTimelineItemCount += max(0, timelineItemCount)
	current.state.PendingStatePatchCount += max(0, statePatchCount)
	current.state.PendingMessageUpdateCount += max(0, messageUpdateCount)
	current.state.AttemptCount++
	current.state.FailedReportCount = current.failedReports
	current.state.LastAttemptAtUnixMS = now
	current.state.UpdatedAtUnixMS = now
	return current.state
}

func applyActivitySyncSucceeded(
	current *agentSessionSyncState,
	agentSessionID string,
	timelineItemCount int,
	statePatchCount int,
	messageUpdateCount int,
	now int64,
) WorkspaceAgentSyncState {
	if current.pendingReports > 0 {
		current.pendingReports--
	}
	current.state.AgentSessionID = strings.TrimSpace(agentSessionID)
	current.state.PendingTimelineItemCount = max(0, current.state.PendingTimelineItemCount-max(0, timelineItemCount))
	current.state.PendingStatePatchCount = max(0, current.state.PendingStatePatchCount-max(0, statePatchCount))
	current.state.PendingMessageUpdateCount = max(0, current.state.PendingMessageUpdateCount-max(0, messageUpdateCount))
	current.failedReports = 0
	current.state.FailedReportCount = 0
	current.state.LastError = ""
	if current.pendingReports == 0 {
		current.state.Status = WorkspaceAgentSyncStatusSynced
		current.state.PendingTimelineItemCount = 0
		current.state.PendingStatePatchCount = 0
		current.state.PendingMessageUpdateCount = 0
		current.state.LastSyncedAtUnixMS = now
	} else {
		current.state.Status = WorkspaceAgentSyncStatusPending
	}
	current.state.UpdatedAtUnixMS = now
	return current.state
}

func applyActivitySyncFailed(
	current *agentSessionSyncState,
	agentSessionID string,
	err error,
	now int64,
) WorkspaceAgentSyncState {
	if current.pendingReports > 0 {
		current.pendingReports--
	}
	current.failedReports++
	current.state.AgentSessionID = strings.TrimSpace(agentSessionID)
	current.state.Status = WorkspaceAgentSyncStatusFailed
	current.state.FailedReportCount = current.failedReports
	if err != nil {
		current.state.LastError = strings.TrimSpace(err.Error())
	}
	current.state.UpdatedAtUnixMS = now
	return current.state
}

func syncEntryFromState(syncState WorkspaceAgentSyncState) *agentSessionSyncState {
	agentSessionID := strings.TrimSpace(syncState.AgentSessionID)
	syncState.AgentSessionID = agentSessionID
	failedReports := max(0, syncState.FailedReportCount)
	if syncState.Status == WorkspaceAgentSyncStatusPending {
		syncState.Status = WorkspaceAgentSyncStatusFailed
		if strings.TrimSpace(syncState.LastError) == "" {
			syncState.LastError = "sync result unavailable after desktopd restart"
		}
	}
	if syncState.Status == WorkspaceAgentSyncStatusFailed && failedReports == 0 {
		failedReports = 1
		syncState.FailedReportCount = failedReports
	}
	return &agentSessionSyncState{
		state:         syncState,
		failedReports: failedReports,
	}
}
