package agent

import (
	"strings"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func runtimeResumeInputFromRuntimeSession(session RuntimeSession) RuntimeResumeInput {
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

func runtimeResumeInputFromPersistedSession(session PersistedSession) RuntimeResumeInput {
	return RuntimeResumeInput{
		WorkspaceID:       strings.TrimSpace(session.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(session.ID),
		AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		Cwd:               strings.TrimSpace(session.Cwd),
		Env:               nil,
		Title:             strings.TrimSpace(session.Title),
		Status:            strings.TrimSpace(session.Status),
		Settings:          normalizeComposerSettingsForProvider(session.Provider, cloneComposerSettings(session.Settings)),
		CreatedAtUnixMS:   session.CreatedAtUnixMS,
		UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
		Visible:           boolPointer(visibleFromRuntimeContext(session.RuntimeContext, true)),
		RuntimeContext:    clonePayload(session.RuntimeContext),
	}
}

const WorkspaceAgentSessionOriginImported = "WORKSPACE_AGENT_SESSION_ORIGIN_IMPORTED"

func persistedSessionCanResume(controller RuntimeController, session PersistedSession) bool {
	if controller == nil {
		return false
	}
	// Imported sessions used to be hard-marked non-resumable, which dead-ended
	// the user into starting a brand new conversation. They carry the provider
	// session id captured at import time (codex thread id / claude sessionId), so
	// they can resume in place on the same device; when the underlying provider
	// session is missing, the runtime recreates a fresh one on send instead of
	// blocking (see Controller.ensureLiveAdapterSession). Either way the
	// conversation is continuable, so defer to the adapter's CanResume.
	return controller.CanResume(runtimeResumeInputFromPersistedSession(session))
}

func serviceSession(session RuntimeSession, resumable bool) Session {
	createdAt := timeFromUnixMS(session.CreatedAtUnixMS)
	updatedAt := timeFromUnixMSPointer(session.UpdatedAtUnixMS)
	endedAt := endedAtForStatus(session.Status, updatedAt)
	title := stringPointer(strings.TrimSpace(session.Title))
	normalizedProvider := strings.TrimSpace(session.Provider)
	normalizedSettings := normalizeComposerSettingsForProvider(
		normalizedProvider,
		cloneComposerSettingsPointerValue(session.Settings),
	)
	runtimeContext := normalizeRuntimeContextForProvider(
		normalizedProvider,
		normalizedSettings,
		session.RuntimeContext,
	)
	return Session{
		ID:                 strings.TrimSpace(session.ID),
		UserID:             strings.TrimSpace(session.UserID),
		AgentTargetID:      strings.TrimSpace(session.AgentTargetID),
		Provider:           normalizedProvider,
		ProviderSessionID:  strings.TrimSpace(session.ProviderSessionID),
		Cwd:                strings.TrimSpace(session.Cwd),
		Resumable:          resumable,
		Status:             serviceStatus(session.Status),
		TurnLifecycle:      cloneTurnLifecycle(session.TurnLifecycle),
		SubmitAvailability: cloneSubmitAvailability(session.SubmitAvailability),
		Visible:            session.Visible,
		Settings:           cloneComposerSettingsPointer(&normalizedSettings),
		PermissionConfig:   composerPermissionConfig(normalizedProvider, permissionModeIDFromSettings(&normalizedSettings), preferencesbiz.DefaultDesktopLocale),
		RuntimeContext:     runtimeContext,
		Title:              title,
		PinnedAtUnixMS:     session.PinnedAtUnixMS,
		CreatedAt:          createdAt,
		UpdatedAt:          updatedAt,
		EndedAt:            endedAt,
		LastError:          stringPointer(strings.TrimSpace(session.LastError)),
	}
}

func serviceSessionWithComposerSkillOptions(
	session RuntimeSession,
	resumable bool,
	options []ComposerSkillOption,
) Session {
	result := serviceSession(session, resumable)
	result.RuntimeContext = withFallbackComposerSkillOptionsRuntimeContext(
		result.RuntimeContext,
		options,
	)
	return result
}

func sessionFromPersisted(session PersistedSession, resumable bool) Session {
	createdAtUnixMS := session.CreatedAtUnixMS
	updatedAtUnixMS := session.UpdatedAtUnixMS
	if strings.TrimSpace(session.Origin) == WorkspaceAgentSessionOriginImported {
		createdAtUnixMS = firstNonZeroInt64(session.StartedAtUnixMS, session.CreatedAtUnixMS)
		updatedAtUnixMS = importedSessionDisplayUpdatedAtUnixMS(session)
	}
	return serviceSession(RuntimeSession{
		ID:                strings.TrimSpace(session.ID),
		WorkspaceID:       strings.TrimSpace(session.WorkspaceID),
		UserID:            strings.TrimSpace(session.UserID),
		AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		Cwd:               strings.TrimSpace(session.Cwd),
		Settings:          normalizeComposerSettingsPointerForProvider(session.Provider, &session.Settings),
		RuntimeContext:    clonePayload(session.RuntimeContext),
		Status:            strings.TrimSpace(session.Status),
		Title:             strings.TrimSpace(session.Title),
		LastError:         strings.TrimSpace(session.LastError),
		PinnedAtUnixMS:    session.PinnedAtUnixMS,
		CreatedAtUnixMS:   createdAtUnixMS,
		UpdatedAtUnixMS:   updatedAtUnixMS,
		Visible:           visibleFromRuntimeContext(session.RuntimeContext, true),
	}, resumable)
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
	if len(session.RuntimeContext) == 0 {
		session.RuntimeContext = clonePayload(persisted.RuntimeContext)
	} else {
		session.RuntimeContext = mergeImportRuntimeContextFields(session.RuntimeContext, persisted.RuntimeContext)
	}
	session.PinnedAtUnixMS = persisted.PinnedAtUnixMS
	return session
}

// importRuntimeContextFields are the import-classification markers written
// once at import time (see external_import.go's ReportSessionState call).
// They are a Tutti-app-level annotation, not part of the underlying provider
// adapter's own runtime bookkeeping, so a live RuntimeSession's RuntimeContext
// never sets them itself.
var importRuntimeContextFields = []string{
	"imported",
	"externalImportNoProject",
	"externalSourcePath",
	"noProject",
}

// mergeImportRuntimeContextFields carries the import-classification markers
// forward onto a live runtime session's RuntimeContext. Without this, once an
// imported session is opened/resumed into a live RuntimeSession, its live
// RuntimeContext is non-empty (it carries the adapter's own bookkeeping), so
// the all-or-nothing swap above never runs — silently dropping
// "imported": true from the projected Session. The frontend's unread-badge
// guard depends on that flag staying set, so losing it made a read imported
// Codex session's unread badge reappear once its runtime session activated.
func mergeImportRuntimeContextFields(live map[string]any, persisted map[string]any) map[string]any {
	if len(persisted) == 0 {
		return live
	}
	merged := live
	cloned := false
	for _, key := range importRuntimeContextFields {
		if _, ok := merged[key]; ok {
			continue
		}
		value, ok := persisted[key]
		if !ok {
			continue
		}
		if !cloned {
			next := make(map[string]any, len(live)+len(importRuntimeContextFields))
			for k, v := range live {
				next[k] = v
			}
			merged = next
			cloned = true
		}
		merged[key] = clonePayloadValue(value)
	}
	return merged
}

func permissionModeIDFromSettings(settings *ComposerSettings) string {
	if settings == nil {
		return ""
	}
	return strings.TrimSpace(settings.PermissionModeID)
}

func visibleFromRuntimeContext(runtimeContext map[string]any, defaultVisible bool) bool {
	if runtimeContext == nil {
		return defaultVisible
	}
	value, ok := runtimeContext["visible"]
	if !ok {
		return defaultVisible
	}
	visible, ok := value.(bool)
	if !ok {
		return defaultVisible
	}
	return visible
}

func boolPointer(value bool) *bool {
	return &value
}

func serviceStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "working":
		return "running"
	case "waiting":
		return "waiting"
	case "completed":
		return "completed"
	case "canceled":
		return "canceled"
	case "failed":
		return "failed"
	default:
		return "created"
	}
}

func endedAtForStatus(status string, updatedAt *time.Time) *time.Time {
	switch strings.TrimSpace(status) {
	case "completed", "canceled", "failed":
		return updatedAt
	default:
		return nil
	}
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

func sessionUpdatedAtUnixMS(session Session) int64 {
	if session.UpdatedAt != nil {
		return session.UpdatedAt.UnixMilli()
	}
	return session.CreatedAt.UnixMilli()
}
