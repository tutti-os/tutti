package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
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
		Settings:          normalizeObservedComposerSettingsForProvider(session.Provider, cloneComposerSettingsPointerValue(session.Settings)),
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
		Settings:               normalizeObservedComposerSettingsForProvider(session.Provider, cloneComposerSettings(session.Settings)),
		CreatedAtUnixMS:        session.CreatedAtUnixMS,
		UpdatedAtUnixMS:        session.UpdatedAtUnixMS,
		Visible:                boolPointer(session.Metadata.Visible),
		RuntimeContext:         runtimeContext,
		Metadata:               session.Metadata,
		InternalRuntimeContext: clonePayload(session.InternalRuntimeContext),
	}
}

const WorkspaceAgentSessionOriginImported = agenthost.WorkspaceAgentSessionOriginImported

func (s *Service) persistedSessionCanResume(ctx context.Context, session PersistedSession) bool {
	controller := s.controller()
	if controller == nil {
		return false
	}
	if strings.TrimSpace(session.Kind) == agentactivitybiz.SessionKindChild {
		return false
	}
	if strings.TrimSpace(session.Origin) == WorkspaceAgentSessionOriginImported &&
		!externalImportResumeSupported(session.InternalRuntimeContext) {
		return false
	}
	input := runtimeResumeInputFromPersistedSession(session)
	if input.AgentTargetID != "" {
		launchInput := CreateSessionInput{
			AgentTargetID: input.AgentTargetID,
			Provider:      input.Provider,
		}
		launch, err := s.resolveCreateSessionLaunch(ctx, session.WorkspaceID, &launchInput)
		if err != nil {
			return false
		}
		input.Provider = launch.Provider
		input.ProviderTargetRef = launch.ProviderTargetRef
	}
	return controller.CanResume(input)
}

func externalImportResumeSupported(runtimeContext map[string]any) bool {
	return agenthost.ExternalImportResumeSupported(runtimeContext)
}

func serviceSession(session ProviderRuntimeSession, resumable bool) Session {
	createdAt := timeFromUnixMS(session.CreatedAtUnixMS)
	updatedAt := timeFromUnixMSPointer(session.UpdatedAtUnixMS)
	title := stringPointer(strings.TrimSpace(session.Title))
	normalizedProvider := strings.TrimSpace(session.Provider)
	normalizedSettings := normalizeObservedComposerSettingsForProvider(
		normalizedProvider,
		cloneComposerSettingsPointerValue(session.Settings),
	)
	normalizedSettings = composerSettingsWithRuntimeSnapshot(
		normalizedSettings,
		session.RuntimeContext,
	)
	metadata, internalRuntimeContext, err := agentactivitybiz.SplitSessionRuntimeContext(session.RuntimeContext)
	if err != nil {
		metadata = agentactivitybiz.SessionMetadata{Visible: session.Visible, Capabilities: []string{}}
	}
	metadata.Visible = session.Visible
	return Session{
		ID:                strings.TrimSpace(session.ID),
		Kind:              agentactivitybiz.SessionKindRoot,
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
		Isolation:         sessionIsolationFromRuntimeContext(internalRuntimeContext),
	}
}

func (s *Service) initializeRuntimeSession(
	ctx context.Context,
	session ProviderRuntimeSession,
	railPlacement *agenthost.RailPlacement,
) (PersistedSession, error) {
	if s == nil || s.SessionInitializer == nil {
		return PersistedSession{}, fmt.Errorf("initialize workspace agent session: session initializer is unavailable")
	}
	persisted, err := s.SessionInitializer.InitializeRuntimeSession(ctx, session, railPlacement)
	if err != nil {
		return PersistedSession{}, fmt.Errorf("initialize workspace agent session: %w", err)
	}
	if strings.TrimSpace(persisted.ID) != strings.TrimSpace(session.ID) ||
		strings.TrimSpace(persisted.WorkspaceID) != strings.TrimSpace(session.WorkspaceID) {
		return PersistedSession{}, fmt.Errorf("initialize workspace agent session: persisted session identity mismatch")
	}
	if strings.TrimSpace(persisted.RailSectionKey) == "" {
		return PersistedSession{}, fmt.Errorf("initialize workspace agent session: persisted rail section key is empty")
	}
	return persisted, nil
}

func validatePersistedRailSectionKey(session PersistedSession) error {
	if strings.TrimSpace(session.RailSectionKey) == "" {
		return fmt.Errorf("workspace agent session %q has no persisted rail section key", strings.TrimSpace(session.ID))
	}
	return nil
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
		RuntimeContext:    persistedSessionRuntimeContext(session),
	}, resumable)
	result.ActiveTurnID = strings.TrimSpace(session.ActiveTurnID)
	result.RailSectionKey = strings.TrimSpace(session.RailSectionKey)
	result.Kind = strings.TrimSpace(session.Kind)
	if result.Kind == "" {
		result.Kind = agentactivitybiz.SessionKindRoot
	}
	result.RootAgentSessionID = strings.TrimSpace(session.RootAgentSessionID)
	result.RootTurnID = strings.TrimSpace(session.RootTurnID)
	result.ParentAgentSessionID = strings.TrimSpace(session.ParentAgentSessionID)
	result.ParentTurnID = strings.TrimSpace(session.ParentTurnID)
	result.ParentToolCallID = strings.TrimSpace(session.ParentToolCallID)
	result.Metadata = session.Metadata
	result.Isolation = sessionIsolationFromRuntimeContext(session.InternalRuntimeContext)
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
	session.Kind = strings.TrimSpace(persisted.Kind)
	if session.Kind == "" {
		session.Kind = agentactivitybiz.SessionKindRoot
	}
	session.RootAgentSessionID = strings.TrimSpace(persisted.RootAgentSessionID)
	session.RootTurnID = strings.TrimSpace(persisted.RootTurnID)
	session.ParentAgentSessionID = strings.TrimSpace(persisted.ParentAgentSessionID)
	session.ParentTurnID = strings.TrimSpace(persisted.ParentTurnID)
	session.ParentToolCallID = strings.TrimSpace(persisted.ParentToolCallID)
	session.RailSectionKey = strings.TrimSpace(persisted.RailSectionKey)
	if strings.TrimSpace(session.UserID) == "" {
		session.UserID = strings.TrimSpace(persisted.UserID)
	}
	if strings.TrimSpace(session.AgentTargetID) == "" {
		session.AgentTargetID = strings.TrimSpace(persisted.AgentTargetID)
	}
	if session.Settings == nil {
		session.Settings = normalizeComposerSettingsPointerForProvider(session.Provider, &persisted.Settings)
	}
	if session.Settings != nil {
		settings := composerSettingsWithRuntimeSnapshot(
			*session.Settings,
			persistedSessionRuntimeContext(persisted),
		)
		session.Settings = &settings
	}
	session.PermissionConfig = composerPermissionConfig(session.Provider, permissionModeIDFromSettings(session.Settings), preferencesbiz.DefaultDesktopLocale)
	session.PinnedAtUnixMS = persisted.PinnedAtUnixMS
	if persisted.UpdatedAtUnixMS > 0 &&
		(session.UpdatedAt == nil || persisted.UpdatedAtUnixMS > session.UpdatedAt.UnixMilli()) {
		session.UpdatedAt = timeFromUnixMSPointer(persisted.UpdatedAtUnixMS)
	}
	session.Metadata = persisted.Metadata
	if isolation := sessionIsolationFromRuntimeContext(persisted.InternalRuntimeContext); isolation != nil {
		session.Isolation = isolation
	}
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
		settings := composerSettingsWithRuntimeSnapshot(
			*liveSettings,
			persistedSessionRuntimeContext(persisted),
		)
		service.Settings = &settings
	} else if service.Settings == nil {
		service.Settings = normalizeComposerSettingsPointerForProvider(session.Provider, session.Settings)
	}
	service.PermissionConfig = composerPermissionConfig(service.Provider, permissionModeIDFromSettings(service.Settings), preferencesbiz.DefaultDesktopLocale)
	return service
}

func (s *Service) projectHostSessionResult(
	ctx context.Context,
	canonical agentactivitybiz.Session,
	runtime ProviderRuntimeSession,
	live bool,
	requireRailSection bool,
) (Session, error) {
	persisted := persistedSessionFromHost(canonical)
	if requireRailSection && s.SessionReader != nil {
		if err := validatePersistedRailSectionKey(persisted); err != nil {
			return Session{}, err
		}
	}
	var result Session
	if live {
		resumable := s.controller().CanResume(runtimeResumeInputFromRuntimeSession(runtime))
		result = serviceSession(runtime, resumable)
		if s.SessionReader != nil {
			result = serviceSessionWithPersistedFreshness(runtime, persisted, resumable)
		}
	} else {
		result = sessionFromPersisted(persisted, s.persistedSessionCanResume(ctx, persisted))
	}
	return s.withProtocolV2TurnState(ctx, canonical.WorkspaceID, result)
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

func composerSettingsWithRuntimeSnapshot(
	settings ComposerSettings,
	runtimeContext map[string]any,
) ComposerSettings {
	snapshot, exists, err := sessionRuntimeSnapshotFromContext(runtimeContext)
	if err == nil && exists {
		settings.ModelPlanID = strings.TrimSpace(snapshot.ModelPlanID)
	}
	return settings
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
