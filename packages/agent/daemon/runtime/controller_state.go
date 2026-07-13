package agentruntime

import (
	"context"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) UpdateSettings(ctx context.Context, input UpdateSettingsInput) (UpdateSettingsResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return UpdateSettingsResult{}, err
	}
	nextSession := session
	settings := normalizeSessionSettings(nextSession.Settings, nextSession.Provider, nextSession.PermissionModeID)
	if input.Settings.Model != nil {
		settings.Model = strings.TrimSpace(*input.Settings.Model)
	}
	if input.Settings.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*input.Settings.ReasoningEffort)
	}
	if input.Settings.Speed != nil {
		settings.Speed = strings.TrimSpace(*input.Settings.Speed)
	}
	if input.Settings.PlanMode != nil {
		settings.PlanMode = *input.Settings.PlanMode
	}
	if input.Settings.BrowserUse != nil {
		value := *input.Settings.BrowserUse
		settings.BrowserUse = &value
	}
	if input.Settings.ComputerUse != nil {
		value := *input.Settings.ComputerUse
		settings.ComputerUse = &value
	}
	permissionChanged := false
	if input.Settings.PermissionModeID != nil {
		normalized := normalizePermissionModeIDWithFallback(
			nextSession.Provider,
			strings.TrimSpace(*input.Settings.PermissionModeID),
			nextSession.PermissionModeID,
		)
		permissionChanged = normalized != nextSession.PermissionModeID
		settings.PermissionModeID = normalized
		nextSession.PermissionModeID = normalized
	}
	nextSession.Settings = cloneSessionSettings(settings)
	if newSessionAdapter, ok := adapter.(NewSessionSettingsAdapter); ok && newSessionAdapter.RequiresNewSessionForSettings(session, input.Settings) {
		return UpdateSettingsResult{}, ErrSessionSettingsRequireNewSession
	}
	if permissionChanged {
		if permissionAdapter, ok := adapter.(PermissionModeAdapter); ok {
			if err := permissionAdapter.ApplyPermissionMode(ctx, nextSession); err != nil {
				return UpdateSettingsResult{}, err
			}
		}
	}
	if liveSettingsAdapter, ok := adapter.(LiveSettingsAdapter); ok {
		if err := liveSettingsAdapter.ApplySessionSettings(ctx, nextSession, input.Settings); err != nil {
			return UpdateSettingsResult{}, err
		}
	}
	c.store(nextSession)
	return UpdateSettingsResult{
		AgentSessionID: nextSession.AgentSessionID,
		Settings:       settings,
	}, nil
}

func shouldAdvanceSessionUpdatedAtFromEvents(events []activityshared.Event) bool {
	for _, event := range events {
		switch event.Type {
		case activityshared.EventTurnStarted,
			activityshared.EventTurnCompleted,
			activityshared.EventTurnFailed:
			return true
		case activityshared.EventTurnUpdated:
			switch strings.TrimSpace(event.Payload.TurnPhase) {
			case string(activityshared.TurnPhaseWaitingApproval),
				string(activityshared.TurnPhaseWaitingInput),
				string(activityshared.SessionStatusWaiting):
				return true
			}
		}
	}
	return false
}

func (c *Controller) State(roomID, agentSessionID string) (SessionStateSnapshot, error) {
	session, adapter, err := c.sessionAndAdapter(roomID, agentSessionID)
	if err != nil {
		return SessionStateSnapshot{}, err
	}
	snapshot := SessionStateSnapshot{
		RoomID:             session.RoomID,
		AgentSessionID:     session.AgentSessionID,
		AgentTargetID:      session.AgentTargetID,
		Provider:           session.Provider,
		ProviderSessionID:  session.ProviderSessionID,
		Status:             session.Status,
		TurnLifecycle:      cloneRuntimeTurnLifecycle(session.TurnLifecycle),
		SubmitAvailability: cloneRuntimeSubmitAvailability(session.SubmitAvailability),
		PermissionModeID:   session.PermissionModeID,
		Settings:           normalizeOptionalSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
		RuntimeContext: map[string]any{
			"cwd":              session.CWD,
			"title":            session.Title,
			"permissionModeId": session.PermissionModeID,
			"visible":          session.Visible,
		},
		UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
	if snapshot.Settings != nil {
		snapshot.RuntimeContext["model"] = snapshot.Settings.Model
		snapshot.RuntimeContext["reasoningEffort"] = snapshot.Settings.ReasoningEffort
		snapshot.RuntimeContext["speed"] = snapshot.Settings.Speed
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	if stateAdapter, ok := adapter.(StateAdapter); ok {
		override := stateAdapter.SessionState(session)
		if override.RoomID != "" {
			snapshot.RoomID = override.RoomID
		}
		if override.AgentSessionID != "" {
			snapshot.AgentSessionID = override.AgentSessionID
		}
		if override.AgentTargetID != "" {
			snapshot.AgentTargetID = override.AgentTargetID
		}
		if override.Provider != "" {
			snapshot.Provider = override.Provider
		}
		if override.ProviderSessionID != "" {
			snapshot.ProviderSessionID = override.ProviderSessionID
		}
		if override.Status != "" {
			snapshot.Status = override.Status
		}
		if override.TurnLifecycle != nil {
			snapshot.TurnLifecycle = cloneRuntimeTurnLifecycle(override.TurnLifecycle)
		}
		if override.SubmitAvailability != nil {
			snapshot.SubmitAvailability = cloneRuntimeSubmitAvailability(override.SubmitAvailability)
		}
		if override.PermissionModeID != "" {
			snapshot.PermissionModeID = normalizePermissionModeIDWithFallback(
				session.Provider,
				override.PermissionModeID,
				snapshot.PermissionModeID,
			)
		}
		if override.Settings != nil {
			snapshot.Settings = normalizeOptionalSessionSettings(override.Settings, session.Provider, snapshot.PermissionModeID)
		}
		if override.AuthState != "" {
			snapshot.AuthState = override.AuthState
		}
		if override.RuntimeContext != nil {
			snapshot.RuntimeContext = override.RuntimeContext
		}
		if override.PendingInteractive != nil {
			snapshot.PendingInteractive = override.PendingInteractive
		}
		if override.UpdatedAtUnixMS > 0 {
			snapshot.UpdatedAtUnixMS = override.UpdatedAtUnixMS
		}
	}
	if snapshot.RuntimeContext == nil {
		snapshot.RuntimeContext = map[string]any{}
	}
	snapshot.RuntimeContext["permissionModeId"] = snapshot.PermissionModeID
	snapshot.RuntimeContext["visible"] = session.Visible
	if snapshot.Settings != nil {
		snapshot.RuntimeContext["model"] = snapshot.Settings.Model
		snapshot.RuntimeContext["reasoningEffort"] = snapshot.Settings.ReasoningEffort
		snapshot.RuntimeContext["speed"] = snapshot.Settings.Speed
		snapshot.RuntimeContext["planMode"] = snapshot.Settings.PlanMode
	}
	return snapshot, nil
}

func (c *Controller) sessionStateSnapshot(session Session) SessionStateSnapshot {
	snapshot, err := c.State(session.RoomID, session.AgentSessionID)
	if err == nil {
		return snapshot
	}
	return SessionStateSnapshot{
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		AgentTargetID:     session.AgentTargetID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Status:            session.Status,
		TurnLifecycle:     cloneRuntimeTurnLifecycle(session.TurnLifecycle),
		SubmitAvailability: cloneRuntimeSubmitAvailability(
			session.SubmitAvailability,
		),
		PermissionModeID: session.PermissionModeID,
		Settings:         normalizeOptionalSessionSettings(session.Settings, session.Provider, session.PermissionModeID),
		RuntimeContext: map[string]any{
			"cwd":              session.CWD,
			"title":            session.Title,
			"permissionModeId": session.PermissionModeID,
			"visible":          session.Visible,
		},
		UpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
}
