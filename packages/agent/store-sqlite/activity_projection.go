package storesqlite

import (
	agentactivityprojection "github.com/tutti-os/tutti/packages/agent/daemon/activity/projection"
)

func sessionStateReportApplied(input SessionStateReport, session agentactivityprojection.SessionSnapshot) bool {
	if input.OccurredAtUnixMS > 0 &&
		session.LastEventUnixMS > 0 &&
		input.OccurredAtUnixMS < session.LastEventUnixMS {
		return false
	}
	return true
}

func projectionSessionToDTO(session agentactivityprojection.SessionSnapshot) (Session, error) {
	metadata, internal, err := splitSessionRuntimeContext(session.RuntimeContext)
	if err != nil {
		return Session{}, err
	}
	return Session{
		ID:                     session.AgentSessionID,
		WorkspaceID:            session.WorkspaceID,
		Origin:                 session.Origin,
		UserID:                 session.UserID,
		AgentTargetID:          session.AgentTargetID,
		Provider:               session.Provider,
		ProviderSessionID:      session.ProviderSessionID,
		Model:                  session.Model,
		Settings:               cloneJSONMap(session.Settings),
		Metadata:               metadata,
		InternalRuntimeContext: internal,
		Cwd:                    session.CWD,
		Title:                  session.Title,
		MessageVersion:         session.MessageVersion,
		LastEventUnixMS:        session.LastEventUnixMS,
		StartedAtUnixMS:        session.StartedAtUnixMS,
		EndedAtUnixMS:          session.EndedAtUnixMS,
		CreatedAtUnixMS:        session.CreatedAtUnixMS,
		UpdatedAtUnixMS:        session.UpdatedAtUnixMS,
	}, nil
}
