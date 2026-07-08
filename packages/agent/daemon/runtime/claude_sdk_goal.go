package agentruntime

import (
	"context"
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
func (a *ClaudeCodeSDKAdapter) GoalControl(
	ctx context.Context,
	session Session,
	action GoalControlAction,
	objective string,
) ([]activityshared.Event, map[string]any, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	slog.Info("agent session claude sdk goal control",
		"event", "agent_session.claude_sdk.goal.control",
		"agent_session_id", session.AgentSessionID,
		"action", string(action),
	)

	var events []activityshared.Event
	switch action {
	case GoalControlSet:
		objective = strings.TrimSpace(objective)
		if objective == "" {
			return nil, nil, fmt.Errorf("goal objective is required")
		}
		if err := a.applyGoalMirrorAndSend(ctx, session, adapterSession,
			map[string]any{"objective": objective, "status": "active"},
			appServerSlashGoal+" "+objective); err != nil {
			return nil, nil, err
		}
		events = a.goalMirrorEvents(session, "thread_goal_update")
	case GoalControlClear:
		events = a.interruptLiveTurnsForGoalClear(ctx, session, adapterSession)
		if err := a.applyGoalMirrorAndSend(ctx, session, adapterSession, nil, appServerSlashGoal+" clear"); err != nil {
			return nil, nil, err
		}
		events = append(events, a.goalMirrorEvents(session, "thread_goal_cleared")...)
	case GoalControlPause, GoalControlResume:
		return nil, nil, fmt.Errorf("goal %s is not supported for claude sessions: Claude Code has no paused goal state (stop the turn, or clear the goal)", action)
	default:
		return nil, nil, fmt.Errorf("unsupported goal control action %q", action)
	}
	return events, a.localGoal(adapterSession), nil
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
) error {
	previous := a.localGoal(adapterSession)
	a.applyLocalGoal(adapterSession, goal)
	if err := a.sendGoalCommandExec(ctx, session, adapterSession, command); err != nil {
		a.applyLocalGoal(adapterSession, previous)
		return err
	}
	return nil
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
	turnID string,
) ([]activityshared.Event, bool, error) {
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	command, args := splitSlashCommand(visibleText)
	if command != appServerSlashGoal {
		return nil, false, nil
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, true, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	// The submission is recorded like a steered message so the controller
	// closes this Exec's turn record while the running turn keeps owning the
	// session lifecycle; the command itself runs as its own queued turn.
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter":     claudeSDKSidecarAdapterName,
			"steered":     true,
			"goalControl": true,
		}))),
	}
	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, visibleText); ok {
		events = append(events, event)
	}
	if isGoalClearCommandArgs(args) {
		events = append(events, a.interruptLiveTurnsForGoalClear(ctx, session, adapterSession)...)
	}
	if err := a.sendGoalCommandExec(ctx, session, adapterSession, visibleText); err != nil {
		return events, true, err
	}
	return events, true, nil
}

// isGoalClearCommandArgs mirrors claudeGoalSlashPromptUpdate's reserved
// clear keywords.
func isGoalClearCommandArgs(args string) bool {
	switch strings.ToLower(strings.TrimSpace(args)) {
	case "clear", "reset":
		return true
	default:
		return false
	}
}

// interruptLiveTurnsForGoalClear stops the running turn before a /goal clear
// is forwarded. The sidecar queues goal command execs behind the live turn,
// and a goal turn only settles once its condition is met — a queued clear
// would never run while the goal loop keeps working (the stall users see:
// clear sent, goal still driving new work). The sidecar processes its pipe
// in order, so the cancel lands before the clear exec; and an interrupted
// goal stays active CLI-side, so the clear that follows still reaches the
// CLI and clears it. Reuses Cancel for the sidecar interrupt, the
// pending-approval rejection, and the settle-guarded terminal synthesis.
func (a *ClaudeCodeSDKAdapter) interruptLiveTurnsForGoalClear(
	ctx context.Context,
	session Session,
	adapterSession *claudeSDKAdapterSession,
) []activityshared.Event {
	if len(a.liveClaudeSDKTurnIDs(adapterSession)) == 0 {
		return nil
	}
	// Cancel ignores its reason argument and interrupts every live waiter in
	// the adapter registry once (see Cancel implementation).
	cancelEvents, err := a.Cancel(ctx, session, CancelRequest{Reason: "goal_clear"})
	if err != nil {
		slog.Warn("agent session claude sdk goal clear interrupt failed",
			"event", "agent_session.claude_sdk.goal.clear_interrupt_failed",
			"agent_session_id", session.AgentSessionID,
			"error", err.Error(),
		)
		return nil
	}
	return cancelEvents
}

// liveClaudeSDKTurnIDs returns the turns with a registered waiter whose
// terminal event has not left this adapter yet — the sidecar work a goal
// clear must interrupt.
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
) error {
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		return err
	}
	turnID := newID()
	args := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(command), appServerSlashGoal))
	a.mu.Lock()
	previousArm := adapterSession.goalArmTurnID
	if isGoalClearCommandArgs(args) {
		adapterSession.goalArmTurnID = ""
	} else {
		adapterSession.goalArmTurnID = turnID
	}
	a.mu.Unlock()
	// The API context may carry no deadline; a missing sidecar ack must not
	// hang this goroutine forever.
	ctx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "exec",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"turnId":         turnID,
			"prompt":         command,
			"content":        promptContentForClaudeSDK(nil, command),
		},
	})
	if err != nil {
		a.mu.Lock()
		adapterSession.goalArmTurnID = previousArm
		a.mu.Unlock()
	}
	return err
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
	if event, ok := acpGoalUpdatedEvent(session, updateType); ok {
		return []activityshared.Event{event}
	}
	return nil
}
