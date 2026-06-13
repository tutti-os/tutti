package workspace

import (
	"strings"

	agentactivityprojection "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/projection"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func sessionStateReportApplied(input agentactivitybiz.SessionStateReport, session agentactivityprojection.SessionSnapshot) bool {
	if input.OccurredAtUnixMS > 0 &&
		session.LastEventUnixMS > 0 &&
		input.OccurredAtUnixMS < session.LastEventUnixMS {
		return false
	}
	if status := strings.TrimSpace(input.Status); status != "" && status != strings.TrimSpace(session.Status) {
		return false
	}
	if phase := strings.TrimSpace(input.CurrentPhase); phase != "" && phase != strings.TrimSpace(session.CurrentPhase) {
		return false
	}
	return true
}

func projectionSessionToBiz(session agentactivityprojection.SessionSnapshot) agentactivitybiz.Session {
	return agentactivitybiz.Session{
		ID:                session.AgentSessionID,
		WorkspaceID:       session.WorkspaceID,
		Origin:            session.Origin,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		Model:             session.Model,
		Settings:          cloneJSONMap(session.Settings),
		RuntimeContext:    cloneJSONMap(session.RuntimeContext),
		Cwd:               session.CWD,
		Status:            session.Status,
		CurrentPhase:      session.CurrentPhase,
		Title:             session.Title,
		LastError:         session.LastError,
		MessageVersion:    session.MessageVersion,
		LastEventUnixMS:   session.LastEventUnixMS,
		StartedAtUnixMS:   session.StartedAtUnixMS,
		EndedAtUnixMS:     session.EndedAtUnixMS,
		CreatedAtUnixMS:   session.CreatedAtUnixMS,
		UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
	}
}
