package agent

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
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
	Description        string
	ID                 string
	Label              string
	Value              string
	SupportsImageInput *bool
}

type ComposerSettings struct {
	Model            string
	PermissionModeID string
	PlanMode         bool
	// BrowserUse is tri-state: nil means "use the default" (on), so the
	// composer can distinguish an explicit opt-out from an unset value.
	BrowserUse *bool
	// ComputerUse is tri-state: nil means "use the default" (on), so the
	// composer can distinguish an explicit opt-out from an unset value.
	ComputerUse            *bool
	ReasoningEffort        string
	Speed                  string
	ConversationDetailMode string
}

type ComposerOptionsInput struct {
	AgentTargetID            string
	Cwd                      string
	Locale                   string
	Provider                 string
	WorkspaceID              string
	Settings                 ComposerSettings
	IncludeCapabilityCatalog *bool
	providerTargetRef        map[string]any
}

type ComposerSkillOption struct {
	Name        string
	Trigger     string
	SourceKind  string
	Description string
	PluginName  string
	Path        string
	Invocation  string
}

type ComposerCapabilityOption struct {
	ID          string
	Kind        string
	Name        string
	Label       string
	Description string
	Status      string
	Source      string
	PluginName  string
	ServerName  string
	ToolName    string
	Trigger     string
	Path        string
	Invocation  string
}

type ComposerOptions struct {
	Provider           string
	Capabilities       []string
	ModelConfig        ComposerConfigOption
	PermissionConfig   PermissionConfig
	ReasoningConfig    ComposerConfigOption
	SpeedConfig        ComposerConfigOption
	EffectiveSettings  ComposerSettings
	RuntimeContext     map[string]any
	Skills             []ComposerSkillOption
	CapabilityCatalog  []ComposerCapabilityOption
	Behavior           providerregistry.ComposerBehaviorDescriptor
	SlashCommandPolicy *providerregistry.SlashCommandPolicyDescriptor
}

func (s *Service) GetComposerOptions(ctx context.Context, input ComposerOptionsInput) (ComposerOptions, error) {
	provider := agentprovider.Normalize(input.Provider)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if agentTargetID != "" {
		launch, err := s.resolveCreateSessionLaunch(ctx, CreateSessionInput{
			AgentTargetID: agentTargetID,
			Provider:      provider,
		})
		if err != nil {
			return ComposerOptions{}, err
		}
		// The Agent Target is the authority for an extension-owned provider
		// identity. Preserve open provider ids (for example acp:gemini) after the
		// target lookup has validated the launch binding; the closed built-in
		// normalizer would otherwise erase them and reject target-scoped composer
		// option requests before the runtime can start.
		provider = agentprovider.NormalizeOpen(launch.Provider)
		input.Provider = provider
		input.AgentTargetID = agentTargetID
		input.providerTargetRef = clonePayload(launch.ProviderTargetRef)
	}
	if provider == "" {
		return ComposerOptions{}, ErrInvalidArgument
	}
	settings := normalizeComposerSettingsForProvider(provider, ComposerSettings{
		Model:            strings.TrimSpace(input.Settings.Model),
		PermissionModeID: strings.TrimSpace(input.Settings.PermissionModeID),
		PlanMode:         input.Settings.PlanMode,
		BrowserUse:       input.Settings.BrowserUse,
		ComputerUse:      input.Settings.ComputerUse,
		ReasoningEffort:  strings.TrimSpace(input.Settings.ReasoningEffort),
		Speed:            strings.TrimSpace(input.Settings.Speed),
	})
	if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		settings.Model = strings.TrimSpace(input.Settings.Model)
		settings.PermissionModeID = strings.TrimSpace(input.Settings.PermissionModeID)
		settings.PlanMode = input.Settings.PlanMode
	}
	catalogProjection := composerModelCatalogProjection{}
	catalogProjectionOK := false
	if composerOptionsProviderUsesModelCatalog(provider) {
		catalogProjection, catalogProjectionOK = composerModelOptionsFromCatalog(
			ctx,
			s.ModelCatalog,
			provider,
			input.Cwd,
			settings.Model,
		)
	}
	defaultModel := composerConfiguredDefaultModel(provider)
	if catalogProjectionOK && catalogProjection.DefaultModel != "" {
		defaultModel = catalogProjection.DefaultModel
	}
	effectiveSettings := resolveComposerEffectiveSettings(
		provider,
		settings,
		defaultModel,
	)
	locale := normalizeComposerLocale(input.Locale)
	permissionConfig := composerPermissionConfig(provider, effectiveSettings.PermissionModeID, locale)
	modelOptions := s.enrichModelCapabilityOptions(ctx, provider, composerSelectedModelOptions(effectiveSettings.Model))
	if composerProfileFor(provider).Behavior.ModelOptionsAuthoritative {
		modelOptions = []ComposerConfigOptionValue{}
	}
	reasoningOptions := composerReasoningOptionValues(provider, effectiveSettings.ReasoningEffort, locale)
	capabilities := composerProviderCapabilities(provider, s.computerUseAvailable())
	runtimeContext := map[string]any{
		"capabilities":     capabilities,
		"configOptions":    composerConfigOptions(provider, effectiveSettings, modelOptions, reasoningOptions),
		"model":            nullableString(effectiveSettings.Model),
		"permissionModeId": nullableString(effectiveSettings.PermissionModeID),
		"reasoningEffort":  nullableString(effectiveSettings.ReasoningEffort),
		"speed":            nullableString(effectiveSettings.Speed),
	}
	if commands := s.composerCommandsFromRunningSession(
		input.WorkspaceID,
		provider,
		agentTargetID,
	); len(commands) > 0 {
		runtimeContext["availableCommands"] = commands
	}
	slashCommandPolicy := composerSlashCommandPolicy(provider)
	if agentTargetID != "" {
		runtimeContext["agentTargetId"] = agentTargetID
	}
	skills := s.discoverComposerSkillOptionsForLaunch(ctx, provider, input.Cwd, nil, input.providerTargetRef)
	capabilityCatalog := []ComposerCapabilityOption{}
	capabilityErrors := []string(nil)
	if composerOptionsIncludeCapabilityCatalog(input) {
		capabilityCatalog, capabilityErrors = s.listComposerCapabilityOptions(ctx, provider, input.Cwd, skills)
	}
	runtimeContext["skills"] = composerSkillOptionsRuntimeContext(skills)
	runtimeContext["capabilityCatalog"] = composerCapabilityOptionsRuntimeContext(capabilityCatalog)
	if len(capabilityErrors) > 0 {
		runtimeContext["capabilityCatalogErrors"] = capabilityErrors
	}
	if catalogProjectionOK {
		modelOptions = s.enrichModelCapabilityOptions(ctx, provider, catalogProjection.ModelOptions)
		runtimeContext["modelCatalogSource"] = catalogProjection.Source
		if len(catalogProjection.ReasoningProfiles) > 0 {
			runtimeContext["modelReasoningOptionsByModel"] = composerModelReasoningOptionsRuntimeContext(
				provider,
				locale,
				catalogProjection.ReasoningProfiles,
			)
		}
		if profile, advertised := catalogProjection.ReasoningProfiles[effectiveSettings.Model]; advertised {
			effectiveSettings.ReasoningEffort = resolveAdvertisedReasoningEffort(
				provider,
				effectiveSettings.ReasoningEffort,
				profile.DefaultReasoningEffort,
				profile.ReasoningEfforts,
			)
			reasoningOptions = composerAdvertisedReasoningOptionValues(
				provider,
				effectiveSettings.ReasoningEffort,
				locale,
				profile.ReasoningEfforts,
			)
			runtimeContext["reasoningEffort"] = nullableString(effectiveSettings.ReasoningEffort)
		}
		runtimeContext["configOptions"] = composerConfigOptions(provider, effectiveSettings, modelOptions, reasoningOptions)
	}
	options := ComposerOptions{
		Provider:           provider,
		Capabilities:       capabilities,
		ModelConfig:        composerModelConfig(provider, effectiveSettings.Model, modelOptions),
		PermissionConfig:   permissionConfig,
		ReasoningConfig:    composerReasoningConfigFromOptions(provider, effectiveSettings.ReasoningEffort, reasoningOptions),
		SpeedConfig:        composerSpeedConfig(provider, effectiveSettings.Speed, locale),
		EffectiveSettings:  effectiveSettings,
		RuntimeContext:     runtimeContext,
		Skills:             skills,
		CapabilityCatalog:  capabilityCatalog,
		Behavior:           composerProfileFor(provider).Behavior,
		SlashCommandPolicy: slashCommandPolicy,
	}
	if composerProfileFor(provider).LiveModelDiscovery ||
		providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		var err error
		options, err = s.mergeLiveComposerModelsForComposerOptions(ctx, input, effectiveSettings, options)
		if err != nil {
			return ComposerOptions{}, err
		}
	}
	return options, nil
}

func composerOptionsIncludeCapabilityCatalog(input ComposerOptionsInput) bool {
	return input.IncludeCapabilityCatalog == nil || *input.IncludeCapabilityCatalog
}

// composerProviderCapabilities is the conservative static default used to
// render the composer before a session exists. Once a session is live the
// adapter-reported typed session capabilities take precedence in the GUI.
// Keys mirror packages/agent/daemon/runtime/capabilities.go.
func composerProviderCapabilities(provider string, computerUseAvailable bool) []string {
	if !composerProfileKnown(provider) {
		return nil
	}
	profile := composerProfileFor(provider)
	capabilities := append([]string(nil), profile.Capabilities...)
	// Browser use is delivered as a default MCP server to every provider, so the
	// composer advertises it up front when enabled. Live sessions re-report it
	// from session env (runtime adapters), which takes precedence in the GUI.
	if runtimeprep.BrowserUseDefaultEnabled() {
		capabilities = append(capabilities, "browserUse")
	}
	// Computer use requires a local cua-driver before the composer advertises it
	// up front. Live sessions re-report it from session env (runtime adapters),
	// which takes precedence in the GUI.
	if computerUseAvailable && runtimeprep.ComputerUseDefaultEnabled() {
		capabilities = append(capabilities, "computerUse")
	}
	return capabilities
}

func (s *Service) computerUseAvailable() bool {
	if s == nil || s.ComputerUseAvailable == nil {
		return false
	}
	return s.ComputerUseAvailable()
}

func resolveComposerEffectiveSettings(
	provider string,
	requested ComposerSettings,
	defaultModel string,
) ComposerSettings {
	effective := ComposerSettings{
		Model:            strings.TrimSpace(defaultModel),
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
	if requested.ComputerUse != nil {
		value := *requested.ComputerUse
		effective.ComputerUse = &value
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
	return composerProfileFor(provider).DefaultReasoningEffort
}

func composerDefaultModel(
	ctx context.Context,
	provider string,
	cwd string,
	catalog AgentModelCatalog,
) string {
	if composerOptionsProviderUsesModelCatalog(provider) && catalog != nil {
		result, err := catalog.ListModels(ctx, AgentModelCatalogInput{Provider: provider, Cwd: cwd})
		if err == nil {
			for _, model := range result.Models {
				modelID := strings.TrimSpace(model.ID)
				if model.IsDefault && modelID != "" {
					return modelID
				}
			}
		}
	}
	return composerConfiguredDefaultModel(provider)
}

func composerConfiguredDefaultModel(provider string) string {
	if composerProfileFor(provider).ModelCatalog == providerregistry.ModelCatalogKindCodexCLI {
		return strings.TrimSpace(readCodexConfiguredDefaultModel())
	}
	if isClaudeSDKLiveModelProvider(provider) {
		return strings.TrimSpace(readClaudeCodeConfiguredDefaultModel())
	}
	return ""
}

func composerSlashCommandPolicy(provider string) *providerregistry.SlashCommandPolicyDescriptor {
	policy := composerProfileFor(provider).SlashCommandPolicy
	if len(policy.FallbackCommands) == 0 && len(policy.CommandEffects) == 0 {
		return nil
	}
	return &providerregistry.SlashCommandPolicyDescriptor{
		FallbackCommands:            append([]string(nil), policy.FallbackCommands...),
		CommandCatalogAuthoritative: policy.CommandCatalogAuthoritative,
		CommandEffects: append(
			[]providerregistry.SlashCommandEffectDescriptor(nil),
			policy.CommandEffects...,
		),
	}
}

func composerConfigOptions(
	provider string,
	settings ComposerSettings,
	modelOptions []ComposerConfigOptionValue,
	reasoningOptions []ComposerConfigOptionValue,
) []map[string]any {
	profile := composerProfileFor(provider)
	if !profile.ModelSelection && !profile.ReasoningEffort && !profile.Speed {
		return []map[string]any{}
	}
	if modelOptions == nil {
		modelOptions = composerSelectedModelOptions(settings.Model)
	}
	options := make([]map[string]any, 0, 3)
	if profile.ModelSelection && len(modelOptions) > 0 {
		configOptionID := strings.TrimSpace(profile.ModelConfigOptionID)
		if configOptionID == "" {
			configOptionID = "model"
		}
		options = append(options, map[string]any{
			"currentValue": nullableString(settings.Model),
			"id":           configOptionID,
			"options":      composerConfigOptionValuesToRuntimeModelOptions(modelOptions),
		})
	}
	if profile.ReasoningEffort && profile.ReasoningEffortOptions != providerregistry.ReasoningEffortOptionsStrictModelCatalog {
		if len(reasoningOptions) > 0 {
			options = append(options, map[string]any{
				"currentValue": nullableString(settings.ReasoningEffort),
				"id":           reasoningConfigOptionID(provider),
				"options":      composerReasoningOptionValuesToRuntimeOptions(reasoningOptions),
			})
		}
	}
	if profile.Speed {
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
	settings.ConversationDetailMode = normalizeComposerConversationDetailMode(settings.ConversationDetailMode)
	settings.Model = clampComposerModelForProvider(provider, settings.Model)
	settings.PlanMode = clampComposerPlanModeForProvider(provider, settings.PlanMode)
	return settings
}

// normalizeObservedComposerSettingsForProvider normalizes settings attached to
// an already-established runtime or persisted session. Open provider identities
// have already been authorized through their Agent Target at session creation,
// so their provider-owned settings must not be clamped by the closed built-in
// composer registry.
func normalizeObservedComposerSettingsForProvider(provider string, settings ComposerSettings) ComposerSettings {
	if agentprovider.Normalize(provider) != "" || agentprovider.NormalizeOpen(provider) == "" {
		return normalizeComposerSettingsForProvider(provider, settings)
	}
	settings.Model = strings.TrimSpace(settings.Model)
	settings.PermissionModeID = strings.TrimSpace(settings.PermissionModeID)
	settings.ReasoningEffort = strings.TrimSpace(settings.ReasoningEffort)
	settings.Speed = strings.TrimSpace(settings.Speed)
	settings.ConversationDetailMode = normalizeComposerConversationDetailMode(settings.ConversationDetailMode)
	return settings
}

func normalizeComposerConversationDetailMode(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return preferencesbiz.NormalizeDesktopAgentConversationDetailMode(value)
}

// clampComposerModelForProvider clears model overrides for providers without
// model selection support so stale persisted values never reach the runtime.
func clampComposerModelForProvider(provider string, model string) string {
	if !composerProfileFor(provider).ModelSelection {
		return ""
	}
	return strings.TrimSpace(model)
}

func clampComposerModelForLaunch(provider string, providerTargetRef map[string]any, model string) string {
	if providerTargetRefKind(providerTargetRef) == "agent_extension" {
		return strings.TrimSpace(model)
	}
	return clampComposerModelForProvider(provider, model)
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

// clampComposerComputerUseForProvider resolves the tri-state computer-use toggle
// into a concrete bool, clamped for the provider.
func clampComposerComputerUseForProvider(provider string, computerUse *bool) bool {
	if !composerProviderSupportsComputerUse(agentprovider.Normalize(provider)) {
		return false
	}
	return computerUse == nil || *computerUse
}

// composerProviderSupportsComputerUse mirrors the static capability defaults so
// the service layer can gate computer use for providers that cannot use it.
func composerProviderSupportsComputerUse(provider string) bool {
	return composerProviderSupportsCapability(provider, "computerUse")
}

func composerProviderSupportsCapability(provider string, capability string) bool {
	if !composerProfileKnown(provider) {
		return false
	}
	if capability == "browserUse" {
		return runtimeprep.BrowserUseDefaultEnabled()
	}
	if capability == "computerUse" {
		return runtimeprep.ComputerUseDefaultEnabled()
	}
	for _, advertised := range composerProfileFor(provider).Capabilities {
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
	normalized := normalizeObservedComposerSettingsForProvider(provider, *settings)
	if composerProviderUsesModelReasoningCatalog(provider) {
		normalized.ReasoningEffort = strings.TrimSpace(settings.ReasoningEffort)
	}
	return &normalized
}

func defaultPermissionModeIDForProvider(provider string) string {
	return composerProfileFor(provider).DefaultPermissionModeID
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
	profile := composerProfileFor(provider)
	modes := make([]PermissionModeOption, len(profile.PermissionModes))
	copy(modes, profile.PermissionModes)
	return PermissionConfig{
		Configurable: profile.PermissionConfigurable,
		Modes:        modes,
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

func composerOptionsProviderUsesModelCatalog(provider string) bool {
	return composerProfileFor(provider).UsesModelCatalog
}

func composerModelConfig(provider string, selected string, options []ComposerConfigOptionValue) ComposerConfigOption {
	if composerProfileFor(provider).Behavior.ModelOptionsAuthoritative {
		return ComposerConfigOption{}
	}
	values := make([]ComposerConfigOptionValue, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		label := strings.TrimSpace(option.Label)
		if label == "" {
			label = value
		}
		values = append(values, ComposerConfigOptionValue{
			ID:                 value,
			Label:              label,
			Value:              value,
			Description:        strings.TrimSpace(option.Description),
			SupportsImageInput: option.SupportsImageInput,
		})
	}
	selected = strings.TrimSpace(selected)
	return ComposerConfigOption{
		Configurable: composerProfileFor(provider).ModelSelection,
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      values,
	}
}

func composerSelectedModelOptions(model string) []ComposerConfigOptionValue {
	model = strings.TrimSpace(model)
	if model == "" {
		return []ComposerConfigOptionValue{}
	}
	return []ComposerConfigOptionValue{{ID: model, Label: model, Value: model}}
}

func reasoningConfigOptionID(provider string) string {
	return strings.TrimSpace(composerProfileFor(provider).ReasoningConfigOptionID)
}

const (
	speedTierStandard = "standard"
	speedTierFast     = "fast"
)

// speedProviderSupportsSpeed reports whether the provider exposes the speed
// dimension. Speed combines orthogonally with model and reasoning effort.
//
//   - Codex: the codex app-server honours `service_tier` (fast → priority).
//   - Claude Code: the SDK sidecar maps the `standard` / `fast` tiers onto
//     `Settings.fastMode`.
func speedProviderSupportsSpeed(provider string) bool {
	return composerProfileFor(provider).Speed
}

// speedConfigOptionID is the live config-option id the adapter sets. Codex maps
// the tier onto the app-server `service_tier` config; Claude Code sets a `fast`
// ACP config option when the agent advertises it.
func speedConfigOptionID(provider string) string {
	return strings.TrimSpace(composerProfileFor(provider).SpeedConfigOptionID)
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
