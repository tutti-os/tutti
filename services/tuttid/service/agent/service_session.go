package agent

import (
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func runtimeResumeInputFromRuntimeSession(session ProviderRuntimeSession) RuntimeResumeInput {
	return RuntimeResumeInput{
		WorkspaceID:       strings.TrimSpace(session.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(session.ID),
		AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		Cwd:               strings.TrimSpace(session.Cwd),
		Env:               append([]string(nil), session.Env...),
		Title:             strings.TrimSpace(session.Title),
		Status:            strings.TrimSpace(session.Status),
		Settings:          normalizeComposerSettingsForProvider(session.Provider, cloneComposerSettingsPointerValue(session.Settings)),
		CreatedAtUnixMS:   session.CreatedAtUnixMS,
		UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
		Visible:           boolPointer(session.Visible),
		RuntimeContext:    clonePayload(session.RuntimeContext),
	}
}

func persistedRuntimeResumeStatus(activeTurnID string) string {
	if strings.TrimSpace(activeTurnID) != "" {
		return "working"
	}
	return "ready"
}

func persistedSessionRuntimeContext(session PersistedSession) map[string]any {
	return agentactivitybiz.JoinSessionRuntimeContext(session.Metadata, session.InternalRuntimeContext)
}

func runtimeResumeInputFromPersistedSession(session PersistedSession) RuntimeResumeInput {
	runtimeContext := agentactivitybiz.JoinSessionRuntimeContext(session.Metadata, session.InternalRuntimeContext)
	return RuntimeResumeInput{
		WorkspaceID:            strings.TrimSpace(session.WorkspaceID),
		AgentSessionID:         strings.TrimSpace(session.ID),
		AgentTargetID:          strings.TrimSpace(session.AgentTargetID),
		Provider:               strings.TrimSpace(session.Provider),
		ProviderSessionID:      strings.TrimSpace(session.ProviderSessionID),
		Cwd:                    strings.TrimSpace(session.Cwd),
		Env:                    nil,
		Title:                  strings.TrimSpace(session.Title),
		Status:                 persistedRuntimeResumeStatus(session.ActiveTurnID),
		Settings:               normalizeComposerSettingsForProvider(session.Provider, cloneComposerSettings(session.Settings)),
		CreatedAtUnixMS:        session.CreatedAtUnixMS,
		UpdatedAtUnixMS:        session.UpdatedAtUnixMS,
		Visible:                boolPointer(session.Metadata.Visible),
		RuntimeContext:         runtimeContext,
		Metadata:               session.Metadata,
		InternalRuntimeContext: clonePayload(session.InternalRuntimeContext),
	}
}

const WorkspaceAgentSessionOriginImported = "WORKSPACE_AGENT_SESSION_ORIGIN_IMPORTED"

func persistedSessionCanResume(controller RuntimeController, session PersistedSession) bool {
	if controller == nil {
		return false
	}
	if strings.TrimSpace(session.Origin) == WorkspaceAgentSessionOriginImported &&
		!externalImportResumeSupported(session.InternalRuntimeContext) {
		return false
	}
	return controller.CanResume(runtimeResumeInputFromPersistedSession(session))
}

func externalImportResumeSupported(runtimeContext map[string]any) bool {
	value, exists := runtimeContext["externalImportResumeSupported"]
	if !exists {
		return true
	}
	supported, ok := value.(bool)
	return ok && supported
}

func serviceSession(session ProviderRuntimeSession, resumable bool) Session {
	createdAt := timeFromUnixMS(session.CreatedAtUnixMS)
	updatedAt := timeFromUnixMSPointer(session.UpdatedAtUnixMS)
	title := stringPointer(strings.TrimSpace(session.Title))
	normalizedProvider := strings.TrimSpace(session.Provider)
	normalizedSettings := normalizeComposerSettingsForProvider(
		normalizedProvider,
		cloneComposerSettingsPointerValue(session.Settings),
	)
	metadata, _, err := agentactivitybiz.SplitSessionRuntimeContext(session.RuntimeContext)
	if err != nil {
		metadata = agentactivitybiz.SessionMetadata{Visible: session.Visible, Capabilities: []string{}}
	}
	metadata.Visible = session.Visible
	return Session{
		ID:                strings.TrimSpace(session.ID),
		UserID:            strings.TrimSpace(session.UserID),
		AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
		Provider:          normalizedProvider,
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		Cwd:               strings.TrimSpace(session.Cwd),
		Resumable:         resumable,
		Visible:           session.Visible,
		Settings:          cloneComposerSettingsPointer(&normalizedSettings),
		PermissionConfig:  composerPermissionConfig(normalizedProvider, permissionModeIDFromSettings(&normalizedSettings), preferencesbiz.DefaultDesktopLocale),
		Title:             title,
		PinnedAtUnixMS:    session.PinnedAtUnixMS,
		CreatedAt:         createdAt,
		UpdatedAt:         updatedAt,
		Metadata:          metadata,
	}
}

func serviceSessionWithComposerSkillOptions(
	session ProviderRuntimeSession,
	resumable bool,
	options []ComposerSkillOption,
) Session {
	_ = options
	return serviceSession(session, resumable)
}

func sessionFromPersisted(session PersistedSession, resumable bool) Session {
	createdAtUnixMS := session.CreatedAtUnixMS
	updatedAtUnixMS := session.UpdatedAtUnixMS
	if strings.TrimSpace(session.Origin) == WorkspaceAgentSessionOriginImported {
		createdAtUnixMS = firstNonZeroInt64(session.StartedAtUnixMS, session.CreatedAtUnixMS)
		updatedAtUnixMS = importedSessionDisplayUpdatedAtUnixMS(session)
	}
	result := serviceSession(ProviderRuntimeSession{
		ID:                strings.TrimSpace(session.ID),
		WorkspaceID:       strings.TrimSpace(session.WorkspaceID),
		UserID:            strings.TrimSpace(session.UserID),
		AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		Cwd:               strings.TrimSpace(session.Cwd),
		Settings:          normalizeComposerSettingsPointerForProvider(session.Provider, &session.Settings),
		Status:            persistedRuntimeResumeStatus(session.ActiveTurnID),
		Title:             strings.TrimSpace(session.Title),
		PinnedAtUnixMS:    session.PinnedAtUnixMS,
		CreatedAtUnixMS:   createdAtUnixMS,
		UpdatedAtUnixMS:   updatedAtUnixMS,
		Visible:           session.Metadata.Visible,
	}, resumable)
	result.ActiveTurnID = strings.TrimSpace(session.ActiveTurnID)
	result.Metadata = session.Metadata
	return result
}

func importedSessionDisplayUpdatedAtUnixMS(session PersistedSession) int64 {
	if session.EndedAtUnixMS > 0 {
		return session.EndedAtUnixMS
	}
	if session.LastEventUnixMS > 0 && session.LastEventUnixMS != session.UpdatedAtUnixMS {
		return session.LastEventUnixMS
	}
	if session.StartedAtUnixMS > 0 {
		return session.StartedAtUnixMS
	}
	return firstNonZeroInt64(session.LastEventUnixMS, session.UpdatedAtUnixMS)
}

func mergePersistedSessionState(session Session, persisted PersistedSession) Session {
	if strings.TrimSpace(session.UserID) == "" {
		session.UserID = strings.TrimSpace(persisted.UserID)
	}
	if strings.TrimSpace(session.AgentTargetID) == "" {
		session.AgentTargetID = strings.TrimSpace(persisted.AgentTargetID)
	}
	if session.Settings == nil {
		session.Settings = normalizeComposerSettingsPointerForProvider(session.Provider, &persisted.Settings)
	}
	session.PermissionConfig = composerPermissionConfig(session.Provider, permissionModeIDFromSettings(session.Settings), preferencesbiz.DefaultDesktopLocale)
	session.PinnedAtUnixMS = persisted.PinnedAtUnixMS
	session.Metadata = persisted.Metadata
	return session
}

func serviceSessionWithPersistedFreshness(session ProviderRuntimeSession, persisted PersistedSession, resumable bool) Session {
	if !persistedSessionIsNewerThanRuntime(persisted, session) {
		return mergePersistedSessionState(serviceSession(session, resumable), persisted)
	}
	service := sessionFromPersisted(persisted, resumable)
	if strings.TrimSpace(service.ProviderSessionID) == "" {
		service.ProviderSessionID = strings.TrimSpace(session.ProviderSessionID)
	}
	if liveSettings := normalizeComposerSettingsPointerForProvider(session.Provider, session.Settings); liveSettings != nil {
		service.Settings = liveSettings
	} else if service.Settings == nil {
		service.Settings = normalizeComposerSettingsPointerForProvider(session.Provider, session.Settings)
	}
	service.PermissionConfig = composerPermissionConfig(service.Provider, permissionModeIDFromSettings(service.Settings), preferencesbiz.DefaultDesktopLocale)
	return service
}

func persistedSessionIsNewerThanRuntime(persisted PersistedSession, session ProviderRuntimeSession) bool {
	persistedUpdatedAtUnixMS := firstNonZeroInt64(persisted.LastEventUnixMS, persisted.UpdatedAtUnixMS)
	return persistedUpdatedAtUnixMS > 0 &&
		session.UpdatedAtUnixMS > 0 &&
		persistedUpdatedAtUnixMS > session.UpdatedAtUnixMS
}

func permissionModeIDFromSettings(settings *ComposerSettings) string {
	if settings == nil {
		return ""
	}
	return strings.TrimSpace(settings.PermissionModeID)
}

func boolPointer(value bool) *bool {
	return &value
}

func timeFromUnixMS(value int64) time.Time {
	if value <= 0 {
		return time.Now().UTC()
	}
	return time.Unix(0, value*int64(time.Millisecond)).UTC()
}

func timeFromUnixMSPointer(value int64) *time.Time {
	t := timeFromUnixMS(value)
	return &t
}
