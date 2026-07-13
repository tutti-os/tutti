package agent

import (
	"context"
	"log/slog"
	"strings"
)

// GoalControlSessionResult carries the refreshed session plus the goal
// snapshot after a goal control action (nil after clear).
type GoalControlSessionResult struct {
	Session Session
	Goal    map[string]any
}

// GoalControl performs a direct goal action (pause/resume/clear/set) on the
// session's thread. Like Cancel it is a control operation: it never opens a
// turn, so it works while a turn is running.
func (s *Service) GoalControl(ctx context.Context, workspaceID string, agentSessionID string, action string, objective string) (GoalControlSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	slog.Info("workspace agent session goal control requested",
		"event", "workspace_agent_session.goal_control.requested",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	if _, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID); err != nil {
		slog.Warn("workspace agent session goal control prepare failed",
			"event", "workspace_agent_session.goal_control.prepare_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlSessionResult{}, err
	}
	controlResult, err := s.controller().GoalControl(ctx, RuntimeGoalControlInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Action:         action,
		Objective:      objective,
	})
	if err != nil {
		normalizedErr := normalizeRuntimeError(err)
		slog.Warn("workspace agent session goal control runtime request failed",
			"event", "workspace_agent_session.goal_control.runtime_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"action", action,
			"error", normalizedErr.Error(),
		)
		return GoalControlSessionResult{}, normalizedErr
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("workspace agent session goal control refresh failed",
			"event", "workspace_agent_session.goal_control.refresh_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err.Error(),
		)
		return GoalControlSessionResult{}, err
	}
	slog.Info("workspace agent session goal control completed",
		"event", "workspace_agent_session.goal_control.completed",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"action", action,
	)
	return GoalControlSessionResult{Session: session, Goal: controlResult.Goal}, nil
}
