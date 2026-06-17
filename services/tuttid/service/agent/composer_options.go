package agent

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
)

type PermissionModeSemantic string

const (
	PermissionModeSemanticAskBeforeWrite PermissionModeSemantic = "ask-before-write"
	PermissionModeSemanticAcceptEdits    PermissionModeSemantic = "accept-edits"
	PermissionModeSemanticLockedDown     PermissionModeSemantic = "locked-down"
	PermissionModeSemanticAuto           PermissionModeSemantic = "auto"
	PermissionModeSemanticFullAccess     PermissionModeSemantic = "full-access"
	PermissionModeSemanticUnconfigurable PermissionModeSemantic = "unconfigurable"
)

type PermissionModeOption struct {
	Description string
	ID          string
	Semantic    PermissionModeSemantic
	Label       string
}

type PermissionConfig struct {
	Configurable bool
	DefaultValue string
	Modes        []PermissionModeOption
}

type ComposerConfigOption struct {
	Configurable bool
	CurrentValue string
	DefaultValue string
	Options      []ComposerConfigOptionValue
}

type ComposerConfigOptionValue struct {
	Description string
	ID          string
	Label       string
	Value       string
}

type ComposerSettings struct {
	Model            string
	PermissionModeID string
	PlanMode         bool
	// BrowserUse is tri-state: nil means "use the default" (on), so the
	// composer can distinguish an explicit opt-out from an unset value.
	BrowserUse      *bool
	ReasoningEffort string
	Speed           string
}

type ComposerOptionsInput struct {
	Cwd      string
	Locale   string
	Provider string
	Settings ComposerSettings
}

type ComposerSkillOption struct {
	Name        string
	Trigger     string
	SourceKind  string
	Description string
	PluginName  string
}

type ComposerOptions struct {
	Provider          string
	ModelConfig       ComposerConfigOption
	PermissionConfig  PermissionConfig
	ReasoningConfig   ComposerConfigOption
	SpeedConfig       ComposerConfigOption
	EffectiveSettings ComposerSettings
	RuntimeContext    map[string]any
	Skills            []ComposerSkillOption
}

func (s *Service) GetComposerOptions(ctx context.Context, input ComposerOptionsInput) (ComposerOptions, error) {
	provider := agentprovider.Normalize(input.Provider)
	if provider == "" {
		return ComposerOptions{}, ErrInvalidArgument
	}
	settings := normalizeComposerSettingsForProvider(provider, ComposerSettings{
		Model:            strings.TrimSpace(input.Settings.Model),
		PermissionModeID: strings.TrimSpace(input.Settings.PermissionModeID),
		PlanMode:         input.Settings.PlanMode,
		BrowserUse:       input.Settings.BrowserUse,
		ReasoningEffort:  strings.TrimSpace(input.Settings.ReasoningEffort),
		Speed:            strings.TrimSpace(input.Settings.Speed),
	})
	effectiveSettings := resolveComposerEffectiveSettings(
		ctx,
		provider,
		settings,
		s.ModelCatalog,
	)
	locale := normalizeComposerLocale(input.Locale)
	permissionConfig := composerPermissionConfig(provider, effectiveSettings.PermissionModeID, locale)
	modelOptions := composerSelectedModelOptions(effectiveSettings.Model)
	runtimeContext := map[string]any{
		"capabilities":     composerProviderCapabilities(provider),
		"configOptions":    composerConfigOptions(provider, effectiveSettings, modelOptions),
		"model":            nullableString(effectiveSettings.Model),
		"permissionModeId": nullableString(effectiveSettings.PermissionModeID),
		"reasoningEffort":  nullableString(effectiveSettings.ReasoningEffort),
		"speed":            nullableString(effectiveSettings.Speed),
	}
	skills := s.discoverComposerSkillOptions(provider, input.Cwd, nil)
	runtimeContext["skills"] = composerSkillOptionsRuntimeContext(skills)
	if composerOptionsProviderSupportsSettings(provider) {
		if catalogOptions, source, ok := composerModelOptionsFromCatalog(ctx, s.ModelCatalog, provider, effectiveSettings.Model); ok {
			modelOptions = catalogOptions
			runtimeContext["configOptions"] = composerConfigOptions(provider, effectiveSettings, catalogOptions)
			runtimeContext["modelCatalogSource"] = source
		}
	}
	return ComposerOptions{
		Provider:          provider,
		ModelConfig:       composerModelConfig(provider, effectiveSettings.Model, modelOptions),
		PermissionConfig:  permissionConfig,
		ReasoningConfig:   composerReasoningConfig(provider, effectiveSettings.ReasoningEffort, locale),
		SpeedConfig:       composerSpeedConfig(provider, effectiveSettings.Speed, locale),
		EffectiveSettings: effectiveSettings,
		RuntimeContext:    runtimeContext,
		Skills:            skills,
	}, nil
}

// composerProviderCapabilities is the conservative static default used to
// render the composer before a session exists. Once a session is live the
// adapter-reported runtimeContext.capabilities takes precedence (GUI-side
// resolution). Keys mirror packages/agent/daemon/runtime/capabilities.go.
func composerProviderCapabilities(provider string) []string {
	var capabilities []string
	switch agentprovider.Normalize(provider) {
	case agentprovider.ClaudeCode:
		capabilities = []string{"imageInput", "skills", "compact", "tokenUsage", "rateLimits", "planMode", "interrupt"}
	case agentprovider.Codex:
		// planMode pre-session optimism: the adapter re-negotiates at session
		// start (collaborationMode/list) and drops it for older binaries.
		capabilities = []string{"imageInput", "skills", "compact", "tokenUsage", "rateLimits", "planMode", "interrupt"}
	case agentprovider.Gemini, agentprovider.Hermes, agentprovider.Nexight, agentprovider.OpenClaw:
		capabilities = []string{"interrupt"}
	default:
		return nil
	}
	// Browser use is delivered as a default MCP server to every provider, so the
	// composer advertises it up front when enabled. Live sessions re-report it
	// from session env (runtime adapters), which takes precedence in the GUI.
	if agentsidecarservice.BrowserUseDefaultEnabled() {
		capabilities = append(capabilities, "browserUse")
	}
	return capabilities
}

func resolveComposerEffectiveSettings(
	ctx context.Context,
	provider string,
	requested ComposerSettings,
	catalog AgentModelCatalog,
) ComposerSettings {
	effective := ComposerSettings{
		Model:            composerDefaultModel(ctx, provider, catalog),
		PermissionModeID: defaultPermissionModeIDForProvider(provider),
		ReasoningEffort:  composerDefaultReasoningEffort(provider),
		Speed:            composerDefaultSpeed(provider),
	}
	if requested.Model != "" {
		effective.Model = requested.Model
	}
	if requested.PermissionModeID != "" {
		effective.PermissionModeID = requested.PermissionModeID
	}
	if requested.PlanMode {
		effective.PlanMode = true
	}
	if requested.ReasoningEffort != "" {
		effective.ReasoningEffort = requested.ReasoningEffort
	}
	if requested.BrowserUse != nil {
		value := *requested.BrowserUse
		effective.BrowserUse = &value
	}
	if requested.Speed != "" {
		effective.Speed = requested.Speed
	}
	return normalizeComposerSettingsForProvider(provider, effective)
}

// composerDefaultSpeed returns the default speed tier for providers that expose
// the speed dimension; an empty string for providers that do not.
func composerDefaultSpeed(provider string) string {
	if speedProviderSupportsSpeed(provider) {
		return speedTierStandard
	}
	return ""
}

func composerDefaultReasoningEffort(provider string) string {
	switch provider {
	case agentprovider.Codex, agentprovider.ClaudeCode:
		return "high"
	default:
		return ""
	}
}

func composerDefaultModel(
	ctx context.Context,
	provider string,
	catalog AgentModelCatalog,
) string {
	if catalog != nil {
		result, err := catalog.ListModels(ctx, provider)
		if err == nil {
			for _, model := range result.Models {
				modelID := strings.TrimSpace(model.ID)
				if model.IsDefault && modelID != "" {
					return modelID
				}
			}
		}
	}
	switch provider {
	case agentprovider.Codex:
		return strings.TrimSpace(readCodexConfiguredDefaultModel())
	case agentprovider.ClaudeCode:
		return strings.TrimSpace(readClaudeCodeConfiguredDefaultModel())
	default:
		return ""
	}
}

func composerConfigOptions(provider string, settings ComposerSettings, modelOptions []map[string]string) []map[string]any {
	if !composerOptionsProviderSupportsSettings(provider) {
		return []map[string]any{}
	}
	if modelOptions == nil {
		modelOptions = composerSelectedModelOptions(settings.Model)
	}
	options := []map[string]any{
		{
			"currentValue": nullableString(settings.Model),
			"id":           "model",
			"options":      modelOptions,
		},
		{
			"currentValue": nullableString(settings.ReasoningEffort),
			"id":           reasoningConfigOptionID(provider),
			"options":      reasoningEffortOptions(provider, settings.ReasoningEffort),
		},
	}
	if speedProviderSupportsSpeed(provider) {
		options = append(options, map[string]any{
			"currentValue": nullableString(settings.Speed),
			"id":           speedConfigOptionID(provider),
			"options":      speedTierOptions(provider),
		})
	}
	return options
}

func composerPermissionConfig(provider string, selectedModeID string, locale string) PermissionConfig {
	provider = agentprovider.Normalize(provider)
	selectedModeID = normalizePermissionModeIDForProvider(provider, selectedModeID)
	base := permissionConfigForProvider(provider)
	config := PermissionConfig{
		Configurable: base.Configurable,
		DefaultValue: selectedModeID,
		Modes:        make([]PermissionModeOption, 0, len(base.Modes)),
	}
	for _, mode := range base.Modes {
		config.Modes = append(config.Modes, permissionModeOption(provider, mode.ID, mode.Semantic, locale))
	}
	return config
}

func permissionModeOption(provider string, id string, semantic PermissionModeSemantic, locale string) PermissionModeOption {
	label, description := permissionModeDisplay(provider, id, semantic, locale)
	option := PermissionModeOption{
		Description: description,
		ID:          id,
		Semantic:    semantic,
		Label:       label,
	}
	return option
}

func normalizeComposerSettingsForProvider(provider string, settings ComposerSettings) ComposerSettings {
	provider = agentprovider.Normalize(provider)
	settings.Model = strings.TrimSpace(settings.Model)
	settings.PermissionModeID = normalizePermissionModeIDForProvider(provider, settings.PermissionModeID)
	settings.ReasoningEffort = normalizeReasoningEffortForProvider(provider, settings.ReasoningEffort)
	settings.Speed = normalizeSpeedForProvider(provider, settings.Speed)
	settings.Model = clampComposerModelForProvider(provider, settings.Model)
	settings.PlanMode = clampComposerPlanModeForProvider(provider, settings.PlanMode)
	return settings
}

// clampComposerModelForProvider clears model overrides for providers without
// composer settings support so stale persisted values never reach the runtime.
func clampComposerModelForProvider(provider string, model string) string {
	if !agentprovider.SupportsComposerSettings(agentprovider.Normalize(provider)) {
		return ""
	}
	return strings.TrimSpace(model)
}

// clampComposerPlanModeForProvider forces plan mode off for providers whose
// static capabilities never negotiate it.
func clampComposerPlanModeForProvider(provider string, planMode bool) bool {
	return planMode && composerProviderSupportsPlanMode(agentprovider.Normalize(provider))
}

// composerProviderSupportsPlanMode mirrors the static capability defaults so
// the daemon clamps plan mode for providers that never negotiate it.
func composerProviderSupportsPlanMode(provider string) bool {
	return composerProviderSupportsCapability(provider, "planMode")
}

// clampComposerBrowserUseForProvider resolves the tri-state browser-use toggle
// to a concrete bool. Browser use defaults on (nil request → on) but is forced
// off for providers that never advertise the capability.
func clampComposerBrowserUseForProvider(provider string, browserUse *bool) bool {
	if !composerProviderSupportsBrowserUse(agentprovider.Normalize(provider)) {
		return false
	}
	// nil means "use the default" (on).
	return browserUse == nil || *browserUse
}

// composerProviderSupportsBrowserUse mirrors the static capability defaults so
// the daemon clamps browser use for providers that never advertise it.
func composerProviderSupportsBrowserUse(provider string) bool {
	return composerProviderSupportsCapability(provider, "browserUse")
}

func composerProviderSupportsCapability(provider string, capability string) bool {
	for _, advertised := range composerProviderCapabilities(provider) {
		if advertised == capability {
			return true
		}
	}
	return false
}

func normalizeComposerSettingsPointerForProvider(provider string, settings *ComposerSettings) *ComposerSettings {
	if settings == nil {
		return nil
	}
	normalized := normalizeComposerSettingsForProvider(provider, *settings)
	return &normalized
}

func defaultPermissionModeIDForProvider(provider string) string {
	switch agentprovider.Normalize(provider) {
	case agentprovider.ClaudeCode:
		return "default"
	case agentprovider.Codex, agentprovider.Nexight:
		return "auto"
	case agentprovider.Gemini, agentprovider.Hermes:
		return "yolo"
	default:
		return ""
	}
}

func normalizePermissionModeIDForProvider(provider string, value string) string {
	provider = agentprovider.Normalize(provider)
	value = strings.TrimSpace(value)
	if value != "" && permissionModeConfigHasModeID(permissionConfigForProvider(provider), value) {
		return value
	}
	return defaultPermissionModeIDForProvider(provider)
}

func permissionConfigForProvider(provider string) PermissionConfig {
	switch agentprovider.Normalize(provider) {
	case agentprovider.Codex, agentprovider.Nexight:
		return PermissionConfig{
			Configurable: true,
			Modes: []PermissionModeOption{
				{ID: "read-only", Semantic: PermissionModeSemanticAskBeforeWrite},
				{ID: "auto", Semantic: PermissionModeSemanticAuto},
				{ID: "full-access", Semantic: PermissionModeSemanticFullAccess},
			},
		}
	case agentprovider.ClaudeCode:
		return PermissionConfig{
			Configurable: true,
			Modes: []PermissionModeOption{
				{ID: "default", Semantic: PermissionModeSemanticAskBeforeWrite},
				{ID: "acceptEdits", Semantic: PermissionModeSemanticAcceptEdits},
				{ID: "dontAsk", Semantic: PermissionModeSemanticLockedDown},
				{ID: "bypassPermissions", Semantic: PermissionModeSemanticFullAccess},
			},
		}
	case agentprovider.Gemini, agentprovider.Hermes:
		return PermissionConfig{
			Configurable: false,
			Modes: []PermissionModeOption{
				{ID: "yolo", Semantic: PermissionModeSemanticUnconfigurable},
			},
		}
	case agentprovider.OpenClaw:
		return PermissionConfig{
			Configurable: false,
			Modes:        []PermissionModeOption{},
		}
	default:
		return PermissionConfig{
			Configurable: false,
			Modes:        []PermissionModeOption{},
		}
	}
}

func permissionModeConfigHasModeID(config PermissionConfig, modeID string) bool {
	modeID = strings.TrimSpace(modeID)
	if modeID == "" {
		return false
	}
	for _, mode := range config.Modes {
		if strings.TrimSpace(mode.ID) == modeID {
			return true
		}
	}
	return false
}

func composerOptionsProviderSupportsSettings(provider string) bool {
	return agentprovider.SupportsComposerSettings(provider)
}

func composerModelConfig(provider string, selected string, options []map[string]string) ComposerConfigOption {
	values := make([]ComposerConfigOptionValue, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option["value"])
		if value == "" {
			continue
		}
		label := strings.TrimSpace(option["name"])
		if label == "" {
			label = value
		}
		values = append(values, ComposerConfigOptionValue{
			ID:    value,
			Label: label,
			Value: value,
		})
	}
	selected = strings.TrimSpace(selected)
	return ComposerConfigOption{
		Configurable: composerOptionsProviderSupportsSettings(provider),
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      values,
	}
}

func composerReasoningConfig(provider string, selected string, locale string) ComposerConfigOption {
	values := reasoningEffortValuesForProvider(provider)
	options := make([]ComposerConfigOptionValue, 0, len(values)+1)
	containsSelected := false
	for _, value := range values {
		if value == selected {
			containsSelected = true
		}
		options = append(options, ComposerConfigOptionValue{
			ID:    value,
			Label: reasoningEffortLabel(value, locale),
			Value: value,
		})
	}
	selected = normalizeReasoningEffortForProvider(provider, selected)
	if selected != "" && !containsSelected {
		options = append(options, ComposerConfigOptionValue{
			ID:    selected,
			Label: reasoningEffortLabel(selected, locale),
			Value: selected,
		})
	}
	return ComposerConfigOption{
		Configurable: composerOptionsProviderSupportsSettings(provider),
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      options,
	}
}

func composerModelOptionsFromCatalog(ctx context.Context, catalog AgentModelCatalog, provider string, selectedModel string) ([]map[string]string, string, bool) {
	if catalog == nil {
		return nil, "", false
	}
	result, err := catalog.ListModels(ctx, provider)
	if err != nil {
		return nil, "", false
	}
	options := make([]map[string]string, 0, len(result.Models)+1)
	for _, model := range result.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			continue
		}
		if containsModelOption(options, id) {
			continue
		}
		name := strings.TrimSpace(model.DisplayName)
		if name == "" {
			name = id
		}
		options = append(options, map[string]string{
			"name":  name,
			"value": id,
		})
	}
	selected := strings.TrimSpace(selectedModel)
	if selected != "" && !containsModelOption(options, selected) {
		options = append(options, map[string]string{"name": selected, "value": selected})
	}
	return options, strings.TrimSpace(result.Source), true
}

func containsModelOption(options []map[string]string, value string) bool {
	for _, option := range options {
		if option["value"] == value {
			return true
		}
	}
	return false
}

func composerSelectedModelOptions(model string) []map[string]string {
	model = strings.TrimSpace(model)
	if model == "" {
		return []map[string]string{}
	}
	return []map[string]string{{"name": model, "value": model}}
}

func reasoningConfigOptionID(provider string) string {
	if provider == "codex" {
		return "reasoning_effort"
	}
	return "effort"
}

const (
	speedTierStandard = "standard"
	speedTierFast     = "fast"
)

// speedProviderSupportsSpeed reports whether the provider exposes the speed
// dimension. Speed combines orthogonally with model and reasoning effort.
//
//   - Codex: the codex app-server honours `service_tier` (fast → priority).
//   - Claude Code: requires the patched claude-agent-acp bridge that advertises
//     a `fast` config option backed by the SDK's `Settings.fastMode` (applied
//     automatically on install, or via `pnpm patch:claude-agent-acp`). Stock
//     bridges (≤0.44) do not
//     advertise it; there the daemon's `supported["fast"]` gate skips it and the
//     dropdown/`/fast` are simply a no-op until the patch is applied.
func speedProviderSupportsSpeed(provider string) bool {
	switch agentprovider.Normalize(provider) {
	case agentprovider.Codex, agentprovider.ClaudeCode:
		return composerOptionsProviderSupportsSettings(provider)
	default:
		return false
	}
}

// speedConfigOptionID is the live config-option id the adapter sets. Codex maps
// the tier onto the app-server `service_tier` config; Claude Code sets a `fast`
// ACP config option when the agent advertises it.
func speedConfigOptionID(provider string) string {
	if agentprovider.Normalize(provider) == agentprovider.Codex {
		return "service_tier"
	}
	return "fast"
}

func speedTierValuesForProvider(provider string) []string {
	if speedProviderSupportsSpeed(provider) {
		return []string{speedTierStandard, speedTierFast}
	}
	return nil
}

func normalizeSpeedForProvider(provider string, value string) string {
	if !speedProviderSupportsSpeed(provider) {
		return ""
	}
	normalized := strings.TrimSpace(value)
	for _, candidate := range speedTierValuesForProvider(provider) {
		if candidate == normalized {
			return normalized
		}
	}
	return speedTierStandard
}

func speedTierOptions(provider string) []map[string]string {
	values := speedTierValuesForProvider(provider)
	options := make([]map[string]string, 0, len(values))
	for _, value := range values {
		options = append(options, map[string]string{
			"name":  speedLabel(value, preferencesbiz.DefaultDesktopLocale),
			"value": value,
		})
	}
	return options
}

func composerSpeedConfig(provider string, selected string, locale string) ComposerConfigOption {
	values := speedTierValuesForProvider(provider)
	options := make([]ComposerConfigOptionValue, 0, len(values))
	for _, value := range values {
		label, description := speedDisplay(value, locale)
		options = append(options, ComposerConfigOptionValue{
			ID:          value,
			Label:       label,
			Value:       value,
			Description: description,
		})
	}
	selected = normalizeSpeedForProvider(provider, selected)
	return ComposerConfigOption{
		Configurable: speedProviderSupportsSpeed(provider),
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      options,
	}
}

func reasoningEffortOptions(provider string, selected string) []map[string]string {
	values := reasoningEffortValuesForProvider(provider)
	options := make([]map[string]string, 0, len(values)+1)
	containsSelected := false
	for _, value := range values {
		if value == selected {
			containsSelected = true
		}
		options = append(options, map[string]string{
			"name":  reasoningEffortLabel(value, preferencesbiz.DefaultDesktopLocale),
			"value": value,
		})
	}
	selected = normalizeReasoningEffortForProvider(provider, selected)
	if selected != "" && !containsSelected {
		options = append(options, map[string]string{
			"name":  reasoningEffortLabel(selected, preferencesbiz.DefaultDesktopLocale),
			"value": selected,
		})
	}
	return options
}

func reasoningEffortValuesForProvider(provider string) []string {
	if provider == agentprovider.Codex || provider == agentprovider.ClaudeCode {
		return []string{"low", "medium", "high", "xhigh"}
	}
	return []string{"minimal", "low", "medium", "high", "xhigh"}
}

func normalizeReasoningEffortForProvider(provider string, value string) string {
	provider = agentprovider.Normalize(provider)
	if !agentprovider.SupportsComposerSettings(provider) {
		return ""
	}
	normalized := strings.TrimSpace(value)
	if (provider == agentprovider.Codex || provider == agentprovider.ClaudeCode) && normalized == "minimal" {
		return "high"
	}
	return normalized
}

func nullableString(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}
