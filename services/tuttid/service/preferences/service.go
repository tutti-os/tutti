package preferences

import (
	"context"
	"errors"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	reporterevents "github.com/tutti-os/tutti/services/tuttid/service/reporter/events"
)

type DesktopPreferencesPublisher interface {
	PublishDesktopPreferencesUpdated(context.Context, preferencesbiz.DesktopPreferences) error
}

type AgentComposerDefaultsPublisher interface {
	PublishAgentComposerDefaultsChanged(context.Context, string) error
}

type AgentComposerDefaultsPatchValidator interface {
	ValidateAgentComposerDefaultsPatch(context.Context, string, preferencesbiz.AgentComposerDefaultsPatch) error
}

type ChangeObserver func(
	context.Context,
	preferencesbiz.DesktopPreferences,
	preferencesbiz.DesktopPreferences,
)

type Service struct {
	Store                          workspacedata.PreferencesStore
	Publisher                      DesktopPreferencesPublisher
	AgentComposerDefaultsPublisher AgentComposerDefaultsPublisher
	AgentComposerDefaultsValidator AgentComposerDefaultsPatchValidator
	AnalyticsReporter              reporterservice.Reporter
	changeObservers                []ChangeObserver
}

// RegisterChangeObserver adds a startup-wired observer for successful preference changes.
func (s *Service) RegisterChangeObserver(observer ChangeObserver) {
	if s == nil || observer == nil {
		return
	}
	s.changeObservers = append(s.changeObservers, observer)
}

type PatchAgentComposerDefaultsForTargetInput struct {
	AgentTargetID string
	Patch         preferencesbiz.AgentComposerDefaultsPatch
}

type PatchAgentSessionLaunchModeInput struct {
	WorkspaceID       string
	ProjectSectionKey string
	Mode              string
}

type DesktopPreferencesWriteMode string

const (
	DesktopPreferencesWriteModeReplace            DesktopPreferencesWriteMode = "replace"
	DesktopPreferencesWriteModeInitializeIfAbsent DesktopPreferencesWriteMode = "initializeIfAbsent"
)

type PutInput struct {
	WriteMode DesktopPreferencesWriteMode

	AgentCLIUpdateCheckEnabled bool
	// AgentComposerDefaultsByProvider is accepted for wire compatibility but
	// ignored on write: the legacy provider-keyed defaults are frozen after
	// the one-time migration onto AgentComposerDefaultsByAgentTarget.
	AgentComposerDefaultsByProvider             map[string]preferencesbiz.AgentComposerDefaults
	AgentComposerDefaultsByAgentTarget          map[string]preferencesbiz.AgentComposerDefaults
	AgentGUIConversationRailCollapsedByProvider map[string]bool
	// AgentSessionLaunchModesByWorkspace is accepted for wire compatibility but
	// ignored on write. Launch modes mutate through PatchAgentSessionLaunchMode
	// so concurrent workspace windows cannot replace the global map.
	AgentSessionLaunchModesByWorkspace    *map[string]map[string]string
	AgentConversationDetailMode           string
	AgentDockLayout                       string
	AppCatalogChannel                     string
	BrowserUseConnectionMode              string
	DefaultAgentProvider                  string
	DockIconStyle                         string
	DockPlacement                         string
	DeletedAgentConversationRetentionDays int
	FileDefaultOpenersByExtension         map[string]string
	FeatureFlags                          map[string]bool
	WorkbenchShortcuts                    preferencesbiz.DesktopWorkbenchShortcuts
	Locale                                string
	MinimizeAnimation                     string
	SleepPreventionMode                   string
	ShowAppDeveloperSources               bool
	ThemeSource                           string
	UpdateChannel                         string
	UpdatePolicy                          string
	WindowSnapping                        *DesktopWindowSnappingInput
}

type DesktopWindowSnappingInput struct {
	Enabled        bool
	ShortcutPreset string
}

func (s Service) Get(ctx context.Context) (preferencesbiz.DesktopPreferences, error) {
	if s.Store == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("desktop preferences store is not configured")
	}

	return s.Store.GetDesktopPreferences(ctx)
}

func (s Service) GetAgentComposerDefaultsForTarget(
	ctx context.Context,
	agentTargetID string,
) (preferencesbiz.AgentComposerDefaults, error) {
	stored, err := s.Get(ctx)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, err
	}
	return stored.AgentComposerDefaultsByAgentTarget[strings.TrimSpace(agentTargetID)], nil
}

func (s Service) PatchAgentComposerDefaultsForTarget(
	ctx context.Context,
	input PatchAgentComposerDefaultsForTargetInput,
) (preferencesbiz.AgentComposerDefaults, error) {
	if s.Store == nil {
		return preferencesbiz.AgentComposerDefaults{}, errors.New("desktop preferences store is not configured")
	}
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if agentTargetID == "" {
		return preferencesbiz.AgentComposerDefaults{}, errors.New("agent target id is required")
	}
	patch, err := normalizeAgentComposerDefaultsPatch(input.Patch)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, err
	}
	if s.AgentComposerDefaultsValidator == nil {
		return preferencesbiz.AgentComposerDefaults{}, errors.New("agent composer defaults validator is not configured")
	}
	if err := s.AgentComposerDefaultsValidator.ValidateAgentComposerDefaultsPatch(ctx, agentTargetID, patch); err != nil {
		return preferencesbiz.AgentComposerDefaults{}, err
	}
	patchStore, ok := s.Store.(workspacedata.AgentComposerDefaultsPatchStore)
	if !ok {
		return preferencesbiz.AgentComposerDefaults{}, errors.New("agent composer defaults patch store is not configured")
	}
	defaults, err := patchStore.PatchAgentComposerDefaultsForTarget(ctx, agentTargetID, patch)
	if err != nil {
		return preferencesbiz.AgentComposerDefaults{}, err
	}
	if s.AgentComposerDefaultsPublisher != nil {
		if err := s.AgentComposerDefaultsPublisher.PublishAgentComposerDefaultsChanged(ctx, agentTargetID); err != nil {
			return preferencesbiz.AgentComposerDefaults{}, err
		}
	}
	return defaults, nil
}

func (s Service) PatchAgentSessionLaunchMode(
	ctx context.Context,
	input PatchAgentSessionLaunchModeInput,
) (preferencesbiz.DesktopPreferences, error) {
	if s.Store == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("desktop preferences store is not configured")
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	projectSectionKey := strings.TrimSpace(input.ProjectSectionKey)
	mode := strings.TrimSpace(input.Mode)
	if workspaceID == "" {
		return preferencesbiz.DesktopPreferences{}, errors.New("workspace id is required")
	}
	if projectSectionKey == "" {
		return preferencesbiz.DesktopPreferences{}, errors.New("project section key is required")
	}
	if mode != "local" && mode != "worktree" {
		return preferencesbiz.DesktopPreferences{}, errors.New("agent session launch mode is unsupported")
	}
	patchStore, ok := s.Store.(workspacedata.AgentSessionLaunchModePatchStore)
	if !ok {
		return preferencesbiz.DesktopPreferences{}, errors.New("agent session launch mode patch store is not configured")
	}
	previous, err := s.Store.GetDesktopPreferences(ctx)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}
	preferences, err := patchStore.PatchAgentSessionLaunchMode(ctx, workspaceID, projectSectionKey, mode)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}
	for _, observer := range s.changeObservers {
		observer(ctx, previous, preferences)
	}
	if s.Publisher != nil {
		_ = s.Publisher.PublishDesktopPreferencesUpdated(ctx, preferences)
	}
	return preferences, nil
}

func (s Service) Put(ctx context.Context, input PutInput) (preferencesbiz.DesktopPreferences, error) {
	if s.Store == nil {
		return preferencesbiz.DesktopPreferences{}, errors.New("desktop preferences store is not configured")
	}

	writeMode := input.WriteMode
	if writeMode == "" {
		writeMode = DesktopPreferencesWriteModeReplace
	}
	if writeMode != DesktopPreferencesWriteModeReplace && writeMode != DesktopPreferencesWriteModeInitializeIfAbsent {
		return preferencesbiz.DesktopPreferences{}, errors.New("desktop preferences write mode is unsupported")
	}

	stored, err := s.Store.GetDesktopPreferences(ctx)
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}

	windowSnapping := resolveWindowSnapping(stored, input.WindowSnapping)
	candidate := preferencesbiz.DesktopPreferences{
		AgentCLIUpdateCheckEnabled: input.AgentCLIUpdateCheckEnabled,
		// The legacy provider-keyed defaults are frozen: client input is
		// ignored so nothing writes the old field anymore; the stored value
		// is only kept for downgrade compatibility and should pass through
		// unchanged.
		AgentComposerDefaultsByProvider: stored.AgentComposerDefaultsByProvider,
		// Target defaults are frozen on the full preferences mutation. Only the
		// dedicated daemon-side field patch may change this map.
		AgentComposerDefaultsByAgentTarget:          stored.AgentComposerDefaultsByAgentTarget,
		AgentGUIConversationRailCollapsedByProvider: normalizeAgentGUIConversationRailCollapsedByProvider(input.AgentGUIConversationRailCollapsedByProvider),
		// Launch modes are frozen on the full preferences mutation. Only the
		// dedicated daemon-side single-key patch may change this map.
		AgentSessionLaunchModesByWorkspace:    stored.AgentSessionLaunchModesByWorkspace,
		AgentConversationDetailMode:           preferencesbiz.NormalizeDesktopAgentConversationDetailMode(input.AgentConversationDetailMode),
		AgentDockLayout:                       normalizeAgentDockLayout(input.AgentDockLayout),
		AppCatalogChannel:                     normalizeAppCatalogChannel(input.AppCatalogChannel),
		BrowserUseConnectionMode:              normalizeBrowserUseConnectionMode(input.BrowserUseConnectionMode),
		DefaultAgentProvider:                  normalizeDefaultAgentProvider(input.DefaultAgentProvider),
		DockIconStyle:                         strings.TrimSpace(input.DockIconStyle),
		DockPlacement:                         strings.TrimSpace(input.DockPlacement),
		DeletedAgentConversationRetentionDays: preferencesbiz.NormalizeDeletedAgentConversationRetentionDays(input.DeletedAgentConversationRetentionDays),
		FileDefaultOpenersByExtension:         normalizeFileDefaultOpenersByExtension(input.FileDefaultOpenersByExtension),
		Initialized:                           true,
		FeatureFlags:                          preferencesbiz.NormalizeDesktopFeatureFlags(input.FeatureFlags),
		WorkbenchShortcuts:                    preferencesbiz.NormalizeDesktopWorkbenchShortcuts(input.WorkbenchShortcuts),
		Locale:                                strings.TrimSpace(input.Locale),
		MinimizeAnimation:                     normalizeMinimizeAnimation(input.MinimizeAnimation),
		SleepPreventionMode:                   strings.TrimSpace(input.SleepPreventionMode),
		ShowAppDeveloperSources:               input.ShowAppDeveloperSources,
		ThemeSource:                           strings.TrimSpace(input.ThemeSource),
		UpdateChannel:                         strings.TrimSpace(input.UpdateChannel),
		UpdatePolicy:                          strings.TrimSpace(input.UpdatePolicy),
		WindowSnappingEnabled:                 windowSnapping.Enabled,
		WindowSnappingShortcutPreset:          windowSnapping.ShortcutPreset,
	}

	var preferences preferencesbiz.DesktopPreferences
	if writeMode == DesktopPreferencesWriteModeInitializeIfAbsent {
		// Callers provide the complete candidate row, but tuttid owns the
		// workspace-mode policy for a freshly created profile.
		freshDefaults := preferencesbiz.DefaultDesktopPreferences()
		candidate.FeatureFlags[preferencesbiz.DesktopStandaloneAgentModeFeatureFlag] =
			freshDefaults.FeatureFlags[preferencesbiz.DesktopStandaloneAgentModeFeatureFlag]
		initializer, ok := s.Store.(workspacedata.DesktopPreferencesInitializer)
		if !ok {
			return preferencesbiz.DesktopPreferences{}, errors.New("desktop preferences initializer is not configured")
		}
		var created bool
		preferences, created, err = initializer.InitializeDesktopPreferences(ctx, candidate)
		if err != nil {
			return preferencesbiz.DesktopPreferences{}, err
		}
		if !created {
			return preferences, nil
		}
		// Every fresh-profile row is created through this branch (the field
		// patch writers refuse to materialize a missing row), so this is the
		// single spot that can attribute the assigned initial workspace mode.
		reporterevents.Track(ctx, s.AnalyticsReporter, "settings.workspace_ui_mode_initialized", map[string]any{
			"workspace_ui_mode": workspaceUiModeAnalyticsValue(preferences),
		})
	} else {
		preferences, err = s.Store.PutDesktopPreferences(ctx, candidate)
	}
	if err != nil {
		return preferencesbiz.DesktopPreferences{}, err
	}
	for _, observer := range s.changeObservers {
		observer(ctx, stored, preferences)
	}
	if s.Publisher != nil {
		_ = s.Publisher.PublishDesktopPreferencesUpdated(ctx, preferences)
	}
	return preferences, nil
}

func workspaceUiModeAnalyticsValue(preferences preferencesbiz.DesktopPreferences) string {
	if preferences.FeatureFlags[preferencesbiz.DesktopStandaloneAgentModeFeatureFlag] {
		return "agent"
	}
	return "os"
}

func normalizeAgentComposerDefaultsPatch(
	input preferencesbiz.AgentComposerDefaultsPatch,
) (preferencesbiz.AgentComposerDefaultsPatch, error) {
	if len(input) == 0 {
		return nil, errors.New("agent composer defaults patch is empty")
	}
	result := make(preferencesbiz.AgentComposerDefaultsPatch, len(input))
	for field, value := range input {
		switch field {
		case preferencesbiz.AgentComposerDefaultsFieldCodexSaverMode,
			preferencesbiz.AgentComposerDefaultsFieldRTKSaverMode:
			enabled, ok := value.(bool)
			if !ok {
				return nil, errors.New("agent composer defaults saver mode must be boolean")
			}
			result[field] = enabled
			continue
		case preferencesbiz.AgentComposerDefaultsFieldModel,
			preferencesbiz.AgentComposerDefaultsFieldPermissionModeID,
			preferencesbiz.AgentComposerDefaultsFieldReasoningEffort,
			preferencesbiz.AgentComposerDefaultsFieldSpeed:
		default:
			return nil, errors.New("agent composer defaults patch contains an unsupported field")
		}
		if value == nil {
			result[field] = nil
			continue
		}
		normalized := ""
		switch typed := value.(type) {
		case string:
			normalized = strings.TrimSpace(typed)
		case *string:
			if typed != nil {
				normalized = strings.TrimSpace(*typed)
			}
		default:
			return nil, errors.New("agent composer defaults text patch values must be strings or null")
		}
		if normalized == "" {
			return nil, errors.New("agent composer defaults patch values must be non-empty or null")
		}
		result[field] = normalized
	}
	return result, nil
}

func resolveWindowSnapping(stored preferencesbiz.DesktopPreferences, input *DesktopWindowSnappingInput) DesktopWindowSnappingInput {
	if input != nil {
		return DesktopWindowSnappingInput{
			Enabled:        input.Enabled,
			ShortcutPreset: normalizeWindowSnappingShortcutPreset(input.ShortcutPreset),
		}
	}

	return DesktopWindowSnappingInput{
		Enabled:        stored.WindowSnappingEnabled,
		ShortcutPreset: normalizeWindowSnappingShortcutPreset(stored.WindowSnappingShortcutPreset),
	}
}

func normalizeDefaultAgentProvider(value string) string {
	normalized := agentproviderbiz.Normalize(value)
	if preferencesbiz.IsDesktopDefaultAgentProvider(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopDefaultAgentProvider
}

func normalizeAgentDockLayout(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopAgentDockLayout(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopAgentDockLayout
}

func normalizeAppCatalogChannel(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopAppCatalogChannel(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopAppCatalogChannel
}

func normalizeFileDefaultOpenersByExtension(input map[string]string) map[string]string {
	if input == nil {
		return preferencesbiz.DefaultDesktopPreferences().FileDefaultOpenersByExtension
	}
	result := map[string]string{}
	for extension, opener := range input {
		normalizedExtension := preferencesbiz.NormalizeDesktopFileExtension(extension)
		if normalizedExtension == "" {
			continue
		}
		normalizedOpener := strings.TrimSpace(opener)
		if !preferencesbiz.IsDesktopFileDefaultOpener(normalizedOpener) {
			continue
		}
		result[normalizedExtension] = normalizedOpener
	}
	return result
}

func normalizeBrowserUseConnectionMode(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopBrowserUseConnectionMode(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopBrowserUseConnectionMode
}

func normalizeMinimizeAnimation(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopMinimizeAnimation(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopMinimizeAnimation
}

func normalizeWindowSnappingShortcutPreset(value string) string {
	normalized := strings.TrimSpace(value)
	if preferencesbiz.IsDesktopWindowSnappingShortcutPreset(normalized) {
		return normalized
	}
	return preferencesbiz.DefaultDesktopWindowSnappingShortcut
}

func normalizeAgentGUIConversationRailCollapsedByProvider(input map[string]bool) map[string]bool {
	result := map[string]bool{}
	for provider, collapsed := range input {
		normalizedProvider := agentproviderbiz.Normalize(provider)
		if normalizedProvider == "" {
			continue
		}
		result[normalizedProvider] = collapsed
	}
	return result
}
