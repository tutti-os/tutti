package agentruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// claudeSDKGoalCommandTimeout bounds the sidecar ack round-trip for /goal
// command execs issued by goal controls.
const claudeSDKGoalCommandTimeout = 30 * time.Second

func claudeGoalSlashPromptUpdate(prompt string) (map[string]any, string, bool) {
	text := strings.TrimSpace(prompt)
	if !strings.HasPrefix(text, appServerSlashGoal) {
		return nil, "", false
	}
	if len(text) > len(appServerSlashGoal) {
		switch text[len(appServerSlashGoal)] {
		case ' ', '\t', '\n', '\r':
		default:
			return nil, "", false
		}
	}
	objective := strings.TrimSpace(text[len(appServerSlashGoal):])
	if objective == "" {
		return nil, "", false
	}
	if isGoalClearCommandArgs(objective) {
		return nil, "thread_goal_cleared", true
	}
	return map[string]any{"objective": objective, "status": "active"}, "thread_goal_update", true
}

func claudeSDKGoalStatusPayload(raw json.RawMessage) (map[string]any, bool) {
	var params any
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, false
	}
	attachment := claudeSDKGoalStatusAttachment(params, 6)
	if len(attachment) == 0 {
		return nil, false
	}
	objective := strings.TrimSpace(asString(attachment["condition"]))
	if objective == "" {
		return nil, false
	}
	goal := map[string]any{"objective": objective, "status": "active"}
	if met, ok := attachment["met"].(bool); ok && met {
		goal["status"] = "complete"
	}
	for _, key := range []string{"reason", "iterations", "durationMs", "tokens", "sentinel"} {
		if value, ok := attachment[key]; ok {
			goal[key] = value
		}
	}
	return goal, true
}

func claudeSDKGoalStatusAttachment(value any, depth int) map[string]any {
	if depth <= 0 {
		return nil
	}
	obj := payloadObject(value)
	if len(obj) > 0 {
		if strings.TrimSpace(asString(obj["type"])) == "goal_status" {
			return obj
		}
		if attachment := payloadObject(obj["attachment"]); strings.TrimSpace(asString(attachment["type"])) == "goal_status" {
			return attachment
		}
		for _, child := range obj {
			if attachment := claudeSDKGoalStatusAttachment(child, depth-1); len(attachment) > 0 {
				return attachment
			}
		}
		return nil
	}
	switch items := value.(type) {
	case []any:
		for _, item := range items {
			if attachment := claudeSDKGoalStatusAttachment(item, depth-1); len(attachment) > 0 {
				return attachment
			}
		}
	case []map[string]any:
		for _, item := range items {
			if attachment := claudeSDKGoalStatusAttachment(item, depth-1); len(attachment) > 0 {
				return attachment
			}
		}
	}
	return nil
}

// Claude Code's goal is a session-level entity inside the CLI (a condition
// whose evaluator drives autonomous new turns until it is met), but the SDK
// exposes no API for it: commands go in as /goal prompt text, state comes
// out as goal_status attachments, and there is no paused state — an
// interrupted goal stays active and resumes continuation after the next user
// message. The adapter therefore keeps goal interaction 1:1 with that
// surface: set and clear forward the native /goal command (the sidecar
// queues it behind a live turn), display is observation-only, and
// pause/resume are rejected rather than emulated — a wrapper may shorten
// native operations but must not invent states the CLI cannot honor.
// Providers with a real paused state advertise CapabilityGoalPause; the GUI
// hides the pause/resume controls without it.

// GoalControl performs a direct goal action (GUI banner buttons) without
// claiming the session's turn slot.
func (*ClaudeCodeSDKAdapter) GoalCapabilities() GoalAdapterCapabilities {
	return GoalAdapterCapabilities{
		QuerySupported: false, ClearSupported: true, PauseSupported: false,
		QuiesceGoalTurns: true, ReplaySetAfterRestart: false,
	}
}

func (a *ClaudeCodeSDKAdapter) ApplyGoal(
	ctx context.Context,
	session Session,
	input GoalApplyInput,
) (GoalAdapterResult, error) {
	action := input.Action
	objective := input.Objective
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return GoalAdapterResult{}, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	slog.Info("agent session claude sdk goal control",
		"event", "agent_session.claude_sdk.goal.control",
		"agent_session_id", session.AgentSessionID,
		"action", string(action),
	)

	var events []activityshared.Event
	previousOperationID, previousRevision, previousRepairEpoch := a.replaceClaudeGoalOperationIdentity(adapterSession, input.OperationID, input.Revision, input.RepairEpoch)
	restoreIdentity := func() {
		a.restoreClaudeGoalOperationIdentity(adapterSession, input.OperationID, input.Revision, input.RepairEpoch, previousOperationID, previousRevision, previousRepairEpoch)
	}
	switch action {
	case GoalControlSet:
		objective = strings.TrimSpace(objective)
		if objective == "" {
			restoreIdentity()
			return GoalAdapterResult{}, fmt.Errorf("goal objective is required")
		}
		if err := a.applyGoalMirrorAndSend(ctx, session, adapterSession,
			map[string]any{"objective": objective, "status": "active"},
			appServerSlashGoal+" "+objective, input.OperationID, input.Revision, input.RepairEpoch); err != nil {
			restoreIdentity()
			return GoalAdapterResult{}, err
		}
		events = a.goalMirrorEvents(session, "thread_goal_update")
	case GoalControlClear:
		if err := a.applyGoalMirrorAndSend(ctx, session, adapterSession, nil, appServerSlashGoal+" clear", input.OperationID, input.Revision, input.RepairEpoch); err != nil {
			restoreIdentity()
			return GoalAdapterResult{}, err
		}
		events = append(events, a.goalMirrorEvents(session, "thread_goal_cleared")...)
	case GoalControlPause, GoalControlResume:
		restoreIdentity()
		return GoalAdapterResult{}, fmt.Errorf("goal %s is not supported for claude sessions: Claude Code has no paused goal state (stop the turn, or clear the goal)", action)
	default:
		restoreIdentity()
		return GoalAdapterResult{}, fmt.Errorf("unsupported goal control action %q", action)
	}
	return GoalAdapterResult{
		Events: events, Observation: a.localGoal(adapterSession),
		Evidence:      map[string]any{"source": "claude_command_ack", "confidence": "accepted_only", "phase": "accepted", "repairEpoch": input.RepairEpoch},
		ProviderPhase: "accepted",
	}, nil
}

// GoalControl is retained as an adapter-level compatibility shim for focused
// provider tests; controller consumers use the semantic ApplyGoal contract.
func (a *ClaudeCodeSDKAdapter) GoalControl(ctx context.Context, session Session, action GoalControlAction, objective string) ([]activityshared.Event, map[string]any, error) {
	result, err := a.ApplyGoal(ctx, session, GoalApplyInput{Action: action, Objective: objective})
	return result.Events, result.Observation, err
}

func (a *ClaudeCodeSDKAdapter) replaceClaudeGoalOperationIdentity(adapterSession *claudeSDKAdapterSession, operationID string, revision int64, repairEpoch int64) (string, int64, int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	previousOperationID, previousRevision, previousRepairEpoch := adapterSession.goalOperationID, adapterSession.goalRevision, adapterSession.goalRepairEpoch
	if revision > 0 || strings.TrimSpace(operationID) != "" {
		adapterSession.goalOperationID, adapterSession.goalRevision, adapterSession.goalRepairEpoch = strings.TrimSpace(operationID), revision, repairEpoch
	}
	return previousOperationID, previousRevision, previousRepairEpoch
}

func (a *ClaudeCodeSDKAdapter) restoreClaudeGoalOperationIdentity(adapterSession *claudeSDKAdapterSession, operationID string, revision int64, repairEpoch int64, previousOperationID string, previousRevision int64, previousRepairEpoch int64) {
	if revision <= 0 && strings.TrimSpace(operationID) == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if adapterSession.goalOperationID != strings.TrimSpace(operationID) || adapterSession.goalRevision != revision || adapterSession.goalRepairEpoch != repairEpoch {
		return
	}
	adapterSession.goalOperationID, adapterSession.goalRevision, adapterSession.goalRepairEpoch = previousOperationID, previousRevision, previousRepairEpoch
}

func (a *ClaudeCodeSDKAdapter) ReconcileGoal(_ context.Context, session Session) (GoalAdapterResult, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return GoalAdapterResult{}, ErrSessionDisconnected
	}
	return GoalAdapterResult{
		Observation: a.localGoal(adapterSession),
		Evidence:    map[string]any{"source": "claude_lifecycle_mirror", "confidence": "lifecycle_inferred"},
	}, nil
}

func (*ClaudeCodeSDKAdapter) NormalizeGoalObservation(raw map[string]any) map[string]any {
	return clonePayload(raw)
}

// applyGoalMirrorAndSend updates the local goal mirror and forwards the
// matching /goal command. The mirror is written before the send so the
// reader goroutine cannot observe the goal turn settling ahead of the mirror
// state, and rolled back when the send fails so the GUI never shows a goal
// state the CLI did not receive.
func (a *ClaudeCodeSDKAdapter) applyGoalMirrorAndSend(
	ctx context.Context,
	session Session,
	adapterSession *claudeSDKAdapterSession,
	goal map[string]any,
	command string,
	operationID string,
	revision int64,
	repairEpoch int64,
) error {
	previous := a.localGoal(adapterSession)
	a.applyLocalGoal(adapterSession, goal)
	if err := a.sendGoalCommandExec(ctx, session, adapterSession, command, operationID, revision, repairEpoch); err != nil {
		a.restoreClaudeGoalMirrorIfCurrent(adapterSession, operationID, revision, repairEpoch, previous)
		return err
	}
	return nil
}

func (a *ClaudeCodeSDKAdapter) restoreClaudeGoalMirrorIfCurrent(
	adapterSession *claudeSDKAdapterSession,
	operationID string,
	revision int64,
	repairEpoch int64,
	previous map[string]any,
) {
	a.mu.Lock()
	defer a.mu.Unlock()
	operationID = strings.TrimSpace(operationID)
	if operationID != "" || revision > 0 {
		if adapterSession.goalOperationID != operationID || adapterSession.goalRevision != revision || adapterSession.goalRepairEpoch != repairEpoch {
			return
		}
	}
	adapterSession.liveState.goal = clonePayload(previous)
}

// cancelClaudeSDKGoalTurn fences one exact provider turn from a superseded
// repair epoch. The sidecar validates turnId before interrupting the query;
// terminal lifecycle remains provider-owned.
func (*ClaudeCodeSDKAdapter) cancelClaudeSDKGoalTurn(adapterSession *claudeSDKAdapterSession, session Session, turnID string, revision, repairEpoch int64) {
	turnID = strings.TrimSpace(turnID)
	if adapterSession == nil || turnID == "" {
		return
	}
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID: newID(), Type: "cancel",
		Payload: map[string]any{
			"agentSessionId":  session.AgentSessionID,
			"turnId":          turnID,
			"goalRevision":    revision,
			"goalRepairEpoch": repairEpoch,
		},
	}); err != nil {
		slog.Warn("agent session claude sdk precise goal interrupt failed",
			"event", "agent_session.claude_sdk.goal.precise_interrupt_failed",
			"agent_session_id", session.AgentSessionID,
			"turn_id", turnID,
			"goal_revision", revision,
			"goal_repair_epoch", repairEpoch,
			"error", err.Error(),
		)
	}
}

// ExecGoalControl forwards a typed "/goal …" prompt through the sidecar's
// native prompt queue while another turn holds the session's turn slot, so
// the command is not rejected by the single-turn gate. handled is false when
// the prompt is not a /goal command.
func (a *ClaudeCodeSDKAdapter) ExecGoalControl(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
) ([]activityshared.Event, bool, error) {
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	command, _ := splitSlashCommand(visibleText)
	if command != appServerSlashGoal {
		return nil, false, nil
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, true, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	// The command is a session-level control operation. Its transcript audit
	// message is deliberately turnless; any later model execution is adopted
	// as a separate provider-started Turn.
	events := []activityshared.Event{
		newSessionAuditEventWithID(session, newID(), RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter":     claudeSDKSidecarAdapterName,
			"goalControl": true,
		}))),
	}
	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, visibleText); ok {
		events = append(events, event)
	}
	if err := a.sendGoalCommandExec(ctx, session, adapterSession, visibleText, "", 0, 0); err != nil {
		return events, true, err
	}
	return events, true, nil
}

// isGoalClearCommandArgs recognizes Claude Code's reserved clear keywords.
func isGoalClearCommandArgs(args string) bool {
	switch strings.ToLower(strings.TrimSpace(args)) {
	case "clear", "reset":
		return true
	default:
		return false
	}
}

// liveClaudeSDKTurnIDs is the diagnostic live-waiter view used by lifecycle
// tests. Goal control never uses it to cancel an active Turn.
func (a *ClaudeCodeSDKAdapter) liveClaudeSDKTurnIDs(
	adapterSession *claudeSDKAdapterSession,
) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	ids := make([]string, 0, len(adapterSession.turns))
	for turnID := range adapterSession.turns {
		if _, settled := adapterSession.settledTurns[turnID]; settled {
			continue
		}
		ids = append(ids, turnID)
	}
	sort.Strings(ids)
	return ids
}

// sendGoalCommandExec forwards a /goal command to the sidecar as its own
// exec. The sidecar queues it behind a live turn; its turn events come back
// without a waiter and flow through the session event sink with stamped
// lifecycle snapshots, so the session never strands mid-turn. A set command
// records its turn as the goal's arm turn so completion inference does not
// fire before the goal has actually started running.
func (a *ClaudeCodeSDKAdapter) sendGoalCommandExec(
	ctx context.Context,
	session Session,
	adapterSession *claudeSDKAdapterSession,
	command string,
	operationID string,
	revision int64,
	repairEpoch int64,
) error {
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		return err
	}
	turnID := newID()
	args := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), appServerSlashGoal))
	isClear := isGoalClearCommandArgs(args)
	a.mu.Lock()
	previousArm := adapterSession.goalArmTurnID
	assignedArm := turnID
	if isClear {
		assignedArm = ""
		adapterSession.goalArmTurnID = assignedArm
		if adapterSession.goalClearControlTurns == nil {
			adapterSession.goalClearControlTurns = make(map[string]struct{})
		}
		adapterSession.goalClearControlTurns[turnID] = struct{}{}
	} else {
		adapterSession.goalArmTurnID = assignedArm
	}
	a.mu.Unlock()
	// The API context may carry no deadline; a missing sidecar ack must not
	// hang this goroutine forever.
	ctx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	payload := map[string]any{
		"agentSessionId": session.AgentSessionID,
		"turnId":         turnID,
		"prompt":         command,
		"content":        promptContentForClaudeSDK(nil, command),
	}
	if !isGoalClearCommandArgs(args) {
		payload["turnOrigin"] = "goal_arm"
	}
	if strings.TrimSpace(operationID) != "" && revision > 0 {
		payload["goalOperationId"] = strings.TrimSpace(operationID)
		payload["goalRevision"] = revision
		payload["goalRepairEpoch"] = repairEpoch
		if isGoalClearCommandArgs(args) {
			payload["goalAction"] = "clear"
		} else {
			payload["goalAction"] = "set"
		}
	}
	err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "exec",
		Payload: payload,
	})
	if err != nil {
		a.restoreClaudeGoalArmIfCurrent(adapterSession, operationID, revision, repairEpoch, assignedArm, previousArm)
		if isClear {
			a.mu.Lock()
			delete(adapterSession.goalClearControlTurns, turnID)
			a.mu.Unlock()
		}
	}
	return err
}

func (a *ClaudeCodeSDKAdapter) isGoalClearControlTurn(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) bool {
	if a == nil || adapterSession == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := adapterSession.goalClearControlTurns[strings.TrimSpace(turnID)]
	return ok
}

func (a *ClaudeCodeSDKAdapter) forgetGoalClearControlTurn(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) {
	if a == nil || adapterSession == nil {
		return
	}
	a.mu.Lock()
	delete(adapterSession.goalClearControlTurns, strings.TrimSpace(turnID))
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) restoreClaudeGoalArmIfCurrent(
	adapterSession *claudeSDKAdapterSession,
	operationID string,
	revision int64,
	repairEpoch int64,
	assignedArm string,
	previousArm string,
) {
	a.mu.Lock()
	defer a.mu.Unlock()
	currentOperationID := strings.TrimSpace(adapterSession.goalOperationID)
	operationID = strings.TrimSpace(operationID)
	identityMatches := operationID == "" && revision == 0 ||
		currentOperationID == operationID && adapterSession.goalRevision == revision && adapterSession.goalRepairEpoch == repairEpoch
	if identityMatches && adapterSession.goalArmTurnID == assignedArm {
		adapterSession.goalArmTurnID = previousArm
	}
}

// goalEventsOnTurnSettled reconciles the goal mirror when a turn settles.
// This Claude Code version emits no goal_status attachment on achievement
// (verified against claude CLI stream-json output): the goal loop holds the
// turn open through Stop-hook feedback until the condition is met, so a turn
// settling as turn_completed IS the achievement signal. A manual stop cannot
// be mistaken for it — interrupting an unmet goal yields a result with
// subtype error_during_execution / terminal_reason aborted_streaming
// (verified empirically), which the sidecar maps to turn_canceled or
// turn_failed, never turn_completed — and those keep the goal active
// CLI-side (it resumes after the next user message). A canceled arm turn
// means the /goal set never reached the CLI, so the mirror clears instead of
// claiming a goal the CLI never received.
func (a *ClaudeCodeSDKAdapter) goalEventsOnTurnSettled(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	completed bool,
) []activityshared.Event {
	trimmed := strings.TrimSpace(turnID)
	a.mu.Lock()
	goal := adapterSession.liveState.goal
	armTurnID := adapterSession.goalArmTurnID
	if len(goal) == 0 || asString(goal["status"]) != "active" {
		a.mu.Unlock()
		return nil
	}
	if armTurnID != "" && trimmed != armTurnID {
		// The queued /goal set has not run yet; this settle belongs to an
		// earlier turn and says nothing about the goal.
		a.mu.Unlock()
		return nil
	}
	if !completed {
		if armTurnID != "" && trimmed == armTurnID {
			adapterSession.goalArmTurnID = ""
			adapterSession.liveState.goal = nil
			a.mu.Unlock()
			return a.goalMirrorEvents(session, "thread_goal_cleared")
		}
		a.mu.Unlock()
		return nil
	}
	next := clonePayload(goal)
	next["status"] = "complete"
	adapterSession.liveState.goal = next
	adapterSession.goalArmTurnID = ""
	a.mu.Unlock()
	return a.goalMirrorEvents(session, "thread_goal_update")
}

// localGoal returns a copy of the adapter-local goal mirror.
func (a *ClaudeCodeSDKAdapter) localGoal(adapterSession *claudeSDKAdapterSession) map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	return clonePayload(adapterSession.liveState.goal)
}

func (a *ClaudeCodeSDKAdapter) applyLocalGoal(adapterSession *claudeSDKAdapterSession, goal map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(goal) == 0 {
		adapterSession.liveState.goal = nil
		return
	}
	adapterSession.liveState.goal = clonePayload(goal)
}

func (*ClaudeCodeSDKAdapter) goalMirrorEvents(session Session, updateType string) []activityshared.Event {
	if event, ok := normalizedGoalUpdatedEvent(session, updateType); ok {
		return []activityshared.Event{event}
	}
	return nil
}
