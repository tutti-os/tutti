package agentruntime

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
)

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
		a.applyLocalGoal(adapterSession, map[string]any{"objective": objective, "status": "active"})
		if err := a.sendGoalCommandExec(ctx, session, adapterSession, appServerSlashGoal+" "+objective); err != nil {
			return nil, nil, err
		}
		events = a.goalMirrorEvents(session, "thread_goal_update")
	case GoalControlClear:
		a.applyLocalGoal(adapterSession, nil)
		if err := a.sendGoalCommandExec(ctx, session, adapterSession, appServerSlashGoal+" clear"); err != nil {
			return nil, nil, err
		}
		events = a.goalMirrorEvents(session, "thread_goal_cleared")
	case GoalControlPause, GoalControlResume:
		return nil, nil, fmt.Errorf("goal %s is not supported for claude sessions: Claude Code has no paused goal state (stop the turn, or clear the goal)", action)
	default:
		return nil, nil, fmt.Errorf("unsupported goal control action %q", action)
	}
	return events, a.localGoal(adapterSession), nil
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
	command, _ := splitSlashCommand(visibleText)
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
	if err := a.sendGoalCommandExec(ctx, session, adapterSession, visibleText); err != nil {
		return events, true, err
	}
	return events, true, nil
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
	if strings.EqualFold(args, "clear") {
		adapterSession.goalArmTurnID = ""
	} else {
		adapterSession.goalArmTurnID = turnID
	}
	a.mu.Unlock()
	return a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "exec",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"turnId":         turnID,
			"prompt":         command,
			"content":        promptContentForClaudeSDK(nil, command),
		},
	})
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

func (a *ClaudeCodeSDKAdapter) goalMirrorEvents(session Session, updateType string) []activityshared.Event {
	if event, ok := acpGoalUpdatedEvent(session, updateType); ok {
		return []activityshared.Event{event}
	}
	return nil
}
