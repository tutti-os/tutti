package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const (
	claudeSDKContextRecoveryRuntimeKey        = "contextRecovery"
	claudeSDKContextRecoveryStatePending      = "pending"
	claudeSDKContextRecoveryStateHandoff      = "handoff_pending"
	claudeSDKContextRecoveryStateCompleted    = "completed"
	claudeSDKContextRecoveryTriggerCompaction = "compact_context_overflow"
	claudeSDKGoalIdentityRuntimeKey           = "goalIdentity"
)

type claudeSDKContextRecoveryState struct {
	Generation              int64
	State                   string
	Trigger                 string
	BoundaryTurnID          string
	SourceProviderSessionID string
	HandoffSent             bool
}

func claudeSDKContextRecoveryFromRuntimeContext(
	runtimeContext map[string]any,
) claudeSDKContextRecoveryState {
	payload := payloadMap(runtimeContext, claudeSDKContextRecoveryRuntimeKey)
	if len(payload) == 0 {
		return claudeSDKContextRecoveryState{}
	}
	return claudeSDKContextRecoveryState{
		Generation:              payloadInt64(payload, "generation"),
		State:                   payloadString(payload, "state"),
		Trigger:                 payloadString(payload, "trigger"),
		BoundaryTurnID:          payloadString(payload, "boundaryTurnId"),
		SourceProviderSessionID: payloadString(payload, "sourceProviderSessionId"),
	}
}

func (s *claudeSDKAdapterSession) contextRecoverySnapshot() claudeSDKContextRecoveryState {
	if s == nil {
		return claudeSDKContextRecoveryState{}
	}
	s.contextRecoveryMu.Lock()
	defer s.contextRecoveryMu.Unlock()
	return s.contextRecovery
}

func (s *claudeSDKAdapterSession) markContextRecoveryPending(
	turnID string,
) bool {
	if s == nil {
		return false
	}
	s.contextRecoveryMu.Lock()
	defer s.contextRecoveryMu.Unlock()
	if s.contextRecovery.State == claudeSDKContextRecoveryStatePending {
		return false
	}
	generation := s.contextRecovery.Generation + 1
	if generation <= 0 {
		generation = 1
	}
	s.contextRecovery = claudeSDKContextRecoveryState{
		Generation:              generation,
		State:                   claudeSDKContextRecoveryStatePending,
		Trigger:                 claudeSDKContextRecoveryTriggerCompaction,
		BoundaryTurnID:          strings.TrimSpace(turnID),
		SourceProviderSessionID: strings.TrimSpace(s.providerSessionID),
	}
	return true
}

func (s *claudeSDKAdapterSession) claimContextRecoveryHandoff() (
	claudeSDKContextRecoveryState,
	bool,
) {
	if s == nil {
		return claudeSDKContextRecoveryState{}, false
	}
	s.contextRecoveryMu.Lock()
	defer s.contextRecoveryMu.Unlock()
	if s.contextRecovery.State != claudeSDKContextRecoveryStateHandoff ||
		s.contextRecovery.HandoffSent {
		return claudeSDKContextRecoveryState{}, false
	}
	claimed := s.contextRecovery
	s.contextRecovery.HandoffSent = true
	return claimed, true
}

func (s *claudeSDKAdapterSession) resetContextRecoveryHandoffSent() {
	if s == nil {
		return
	}
	s.contextRecoveryMu.Lock()
	defer s.contextRecoveryMu.Unlock()
	if s.contextRecovery.State == claudeSDKContextRecoveryStateHandoff {
		s.contextRecovery.HandoffSent = false
	}
}

func (s *claudeSDKAdapterSession) completeContextRecoveryHandoff() bool {
	if s == nil {
		return false
	}
	s.contextRecoveryMu.Lock()
	defer s.contextRecoveryMu.Unlock()
	if s.contextRecovery.State != claudeSDKContextRecoveryStateHandoff ||
		!s.contextRecovery.HandoffSent {
		return false
	}
	s.contextRecovery.State = claudeSDKContextRecoveryStateCompleted
	s.contextRecovery.HandoffSent = false
	return true
}

func claudeSDKContextRecoveryRuntimeContext(
	state claudeSDKContextRecoveryState,
) map[string]any {
	if state.Generation <= 0 || strings.TrimSpace(state.State) == "" {
		return nil
	}
	payload := map[string]any{
		"version":    1,
		"generation": state.Generation,
		"state":      strings.TrimSpace(state.State),
		"trigger":    strings.TrimSpace(state.Trigger),
	}
	if value := strings.TrimSpace(state.BoundaryTurnID); value != "" {
		payload["boundaryTurnId"] = value
	}
	if value := strings.TrimSpace(state.SourceProviderSessionID); value != "" {
		payload["sourceProviderSessionId"] = value
	}
	return payload
}

func claudeSDKGoalIdentityFromRuntimeContext(
	runtimeContext map[string]any,
) goalOperationIdentity {
	payload := payloadMap(runtimeContext, claudeSDKGoalIdentityRuntimeKey)
	return goalOperationIdentity{
		operationID: strings.TrimSpace(payloadString(payload, "operationId")),
		revision:    payloadInt64(payload, "revision"),
		repairEpoch: payloadInt64(payload, "repairEpoch"),
	}
}

func claudeSDKGoalIdentityRuntimeContext(
	identity goalOperationIdentity,
) map[string]any {
	if !identity.valid() {
		return nil
	}
	return map[string]any{
		"version":     1,
		"operationId": strings.TrimSpace(identity.operationID),
		"revision":    identity.revision,
		"repairEpoch": identity.repairEpoch,
	}
}

func (*ClaudeCodeSDKAdapter) PrepareContextRecovery(
	session Session,
) (Session, bool, error) {
	recovery := claudeSDKContextRecoveryFromRuntimeContext(session.RuntimeContext)
	if recovery.State != claudeSDKContextRecoveryStatePending {
		return session, false, nil
	}
	recovery.State = claudeSDKContextRecoveryStateHandoff
	recovery.SourceProviderSessionID = firstNonEmptyString(
		strings.TrimSpace(recovery.SourceProviderSessionID),
		strings.TrimSpace(session.ProviderSessionID),
	)
	recovery.HandoffSent = false
	session.RuntimeContext = clonePayload(session.RuntimeContext)
	if session.RuntimeContext == nil {
		session.RuntimeContext = map[string]any{}
	}
	session.RuntimeContext[claudeSDKContextRecoveryRuntimeKey] =
		claudeSDKContextRecoveryRuntimeContext(recovery)
	return session, true, nil
}

func (a *ClaudeCodeSDKAdapter) StartContextRecovery(
	ctx context.Context,
	session Session,
	goal *ContextRecoveryGoal,
) ([]activityshared.Event, error) {
	if goal != nil && (strings.TrimSpace(goal.Objective) == "" ||
		strings.TrimSpace(goal.OperationID) == "" || goal.Revision <= 0 ||
		goal.RepairEpoch < 0) {
		return nil, errors.New("claude context recovery active Goal plan is invalid")
	}
	events, err := a.Start(ctx, session)
	if err != nil {
		return nil, err
	}
	recovered := applySessionEvents(session, events)
	if goal == nil {
		return events, nil
	}
	_, err = a.ApplyGoal(ctx, recovered, GoalApplyInput{
		Action:      GoalControlSet,
		Objective:   strings.TrimSpace(goal.Objective),
		OperationID: strings.TrimSpace(goal.OperationID),
		Revision:    goal.Revision,
		RepairEpoch: goal.RepairEpoch,
	})
	if err != nil {
		if adapterSession := a.getSession(session.AgentSessionID); adapterSession != nil {
			a.removeSession(session.AgentSessionID, adapterSession)
			_ = adapterSession.conn.Close()
		}
		return nil, fmt.Errorf("restore active Goal after Claude context recovery: %w", err)
	}
	return events, nil
}

var _ ContextRecoveryAdapter = (*ClaudeCodeSDKAdapter)(nil)

func (a *ClaudeCodeSDKAdapter) claudeSDKCompactFailedEvents(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	rootTurnID string,
	payload map[string]any,
) []activityshared.Event {
	detail := payloadString(payload, "reason")
	if detail == "" {
		detail = strings.TrimSpace(strings.TrimPrefix(
			payloadString(payload, "content"),
			"Compacting failed:",
		))
	}
	recoveryRequired := payloadBoolValue(payload, "contextRecoveryRequired")
	recoveryMarked := recoveryRequired && adapterSession.markContextRecoveryPending(rootTurnID)
	compact, ok := a.compactMessageEvent(
		adapterSession,
		session,
		rootTurnID,
		messageStreamStateFailed,
		"failed",
		detail,
	)
	if !ok {
		return nil
	}
	if recoveryRequired {
		compact.Payload.Metadata["noticeKind"] = "context_recovery_pending"
		compact.Payload.Metadata["contextRecoveryState"] = "pending"
	}
	events := []activityshared.Event{compact}
	if recoveryMarked {
		events = append(events, newSessionActivityEvent(
			session,
			EventSessionUpdated,
			firstNonEmpty(session.Status, SessionStatusWorking),
			claudeSDKRuntimeContext(session, adapterSession),
		))
	}
	return events
}

func renderClaudeSDKContextRecoveryHostContext(
	session Session,
	state claudeSDKContextRecoveryState,
) string {
	if state.State != claudeSDKContextRecoveryStateHandoff || state.HandoffSent {
		return ""
	}
	cliName := tuttiCLICommandName()
	return `<tutti-host-context schemaVersion="1" kind="claude-context-recovery">` + "\n" +
		"Tutti started a fresh Claude Code provider session because native context compaction failed after the previous context became too large. " +
		fmt.Sprintf("You are continuing Tutti Agent Session %q, but this Claude session does not contain that Session's earlier hidden conversation state. ", strings.TrimSpace(session.AgentSessionID)) +
		fmt.Sprintf("When the current request depends on earlier discussion, use the Tutti CLI already available in this runtime: `%s agent get --session-id \"$TUTTI_AGENT_SESSION_ID\" --json`. ", cliName) +
		"Retrieve only the earlier turns needed for the current request instead of loading the whole transcript. " +
		"Do not claim to remember content you have not read, and say clearly if the history cannot be retrieved. " +
		"The user's current message is delivered separately; restore enough relevant context, then continue it normally.\n" +
		`</tutti-host-context>`
}

func appendClaudeSDKContextRecoveryCompletedEvent(
	events []activityshared.Event,
	adapterSession *claudeSDKAdapterSession,
	session Session,
) []activityshared.Event {
	if !adapterSession.completeContextRecoveryHandoff() {
		return events
	}
	session.ProviderSessionID = strings.TrimSpace(adapterSession.providerSessionID)
	return append(events, newSessionActivityEvent(
		session,
		EventSessionUpdated,
		firstNonEmpty(session.Status, SessionStatusReady),
		claudeSDKRuntimeContext(session, adapterSession),
	))
}
