package agent

import (
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	"strings"
)

func persistedSessionFromActivity(session agentactivitybiz.Session) PersistedSession {
	activeTurnID := strings.TrimSpace(session.ActiveTurnID)
	return PersistedSession{
		ID:                     strings.TrimSpace(session.ID),
		WorkspaceID:            strings.TrimSpace(session.WorkspaceID),
		Origin:                 strings.TrimSpace(session.Origin),
		UserID:                 strings.TrimSpace(session.UserID),
		AgentTargetID:          strings.TrimSpace(session.AgentTargetID),
		Provider:               strings.TrimSpace(session.Provider),
		ProviderSessionID:      strings.TrimSpace(session.ProviderSessionID),
		Cwd:                    strings.TrimSpace(session.Cwd),
		Settings:               composerSettingsFromPayload(session.Settings),
		Metadata:               session.Metadata,
		InternalRuntimeContext: clonePayload(session.InternalRuntimeContext),
		Title:                  strings.TrimSpace(session.Title),
		PinnedAtUnixMS:         session.PinnedAtUnixMS,
		LastEventUnixMS:        session.LastEventUnixMS,
		StartedAtUnixMS:        session.StartedAtUnixMS,
		EndedAtUnixMS:          session.EndedAtUnixMS,
		CreatedAtUnixMS:        session.CreatedAtUnixMS,
		UpdatedAtUnixMS:        session.UpdatedAtUnixMS,
		ActiveTurnID:           activeTurnID,
	}
}

func agentActivitySessionStatus(session agentactivitybiz.Session) string {
	if strings.TrimSpace(session.ActiveTurnID) != "" {
		return "running"
	}
	return "ready"
}

func sessionMessagesFromActivity(messages []agentactivitybiz.Message) []SessionMessage {
	if len(messages) == 0 {
		return nil
	}
	out := make([]SessionMessage, 0, len(messages))
	for _, message := range messages {
		out = append(out, SessionMessage{
			ID:                message.ID,
			AgentSessionID:    strings.TrimSpace(message.AgentSessionID),
			MessageID:         strings.TrimSpace(message.MessageID),
			TurnID:            strings.TrimSpace(message.TurnID),
			Role:              strings.TrimSpace(message.Role),
			Kind:              strings.TrimSpace(message.Kind),
			Status:            strings.TrimSpace(message.Status),
			Payload:           message.Payload,
			OccurredAtUnixMS:  message.OccurredAtUnixMS,
			StartedAtUnixMS:   message.StartedAtUnixMS,
			CompletedAtUnixMS: message.CompletedAtUnixMS,
			CreatedAtUnixMS:   message.CreatedAtUnixMS,
			UpdatedAtUnixMS:   message.UpdatedAtUnixMS,
			Version:           message.Version,
		})
	}
	return out
}
