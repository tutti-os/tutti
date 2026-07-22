package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
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
	Description                string
	ID                         string
	Label                      string
	Value                      string
	SupportsImageInput         *bool
	SupportsReasoningEffort    *bool
	ReasoningEffort            string
	ReasoningEfforts           []AgentModelReasoningEffortOption
	ReasoningEffortsAdvertised bool
	// Requested marks an entry that mirrors the requested/current selection
	// instead of the provider catalog (warm-catalog append of the requested
	// model, selected-model bootstrap echo). Clients keep such entries
	// selectable but must not treat them as proof the provider can run the
	// model — create validation runs against the raw catalog only.
	Requested bool
}

type ComposerSettings = agenthost.ComposerSettings

type ComposerOptionsInput struct {
	AgentTargetID            string
	Cwd                      string
	Locale                   string
	Provider                 string
	WorkspaceID              string
	Settings                 ComposerSettings
	IncludeCapabilityCatalog *bool
	// ResolvedModelPlan is a daemon-only exact plan override supplied by a
	// WorkspaceAgent resolver. It may contain a credential and must never be
	// serialized into runtime context or transport responses.
	ResolvedModelPlan *modelplanbiz.Plan
	// IgnoreModelPlanBinding forces provider-native credentials and model
	// discovery for internal probes and subscription checks that must not
	// inherit the workspace target binding. It is daemon-only and must not be
	// exposed as a user-facing session setting.
	IgnoreModelPlanBinding   bool
	providerTargetRef        map[string]any
	extensionComposerProfile ExtensionComposerProfile
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

type ComposerCommandOption struct {
	Name        string
	Description string
	InputHint   string
}

type ComposerReasoningProfile struct {
	DefaultValue string
	Options      []ComposerConfigOptionValue
}

type ComposerOptions struct {
	Provider                string
	Capabilities            []string
	Commands                []ComposerCommandOption
	ModelConfig             ComposerConfigOption
	PermissionConfig        PermissionConfig
	ReasoningConfig         ComposerConfigOption
	ReasoningOptionsByModel map[string]ComposerReasoningProfile
	SpeedConfig             ComposerConfigOption
	EffectiveSettings       ComposerSettings
	RuntimeContext          map[string]any
	Skills                  []ComposerSkillOption
	CapabilityCatalog       []ComposerCapabilityOption
	Behavior                providerregistry.ComposerBehaviorDescriptor
	SlashCommandPolicy      *providerregistry.SlashCommandPolicyDescriptor
}

func (s *Service) GetComposerOptions(ctx context.Context, input ComposerOptionsInput) (ComposerOptions, error) {
	requestedPermissionModeID := strings.TrimSpace(input.Settings.PermissionModeID)
	provider := agentprovider.Normalize(input.Provider)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	launchInput := CreateSessionInput{}
	if agentTargetID != "" {
		launchInput = CreateSessionInput{
			AgentTargetID: agentTargetID,
			Provider:      provider,
		}
		launch, err := s.resolveCreateSessionLaunch(ctx, input.WorkspaceID, &launchInput)
		if err != nil {
			return ComposerOptions{}, err
		}
		// The Agent Target is the authority for an extension-owned provider
		// identity. Preserve an authorized open provider id after the
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
	if agentTargetID != "" && s.AgentComposerDefaultsReader != nil {
		defaults, err := s.AgentComposerDefaultsReader.GetAgentComposerDefaultsForTarget(ctx, agentTargetID)
		if err != nil {
			return ComposerOptions{}, fmt.Errorf("get agent composer defaults for options: %w", err)
		}
		input.Settings = mergeComposerSettingsWithDefaults(input.Settings, defaults)
	}
	requestedSettings := ComposerSettings{
		Model:            strings.TrimSpace(input.Settings.Model),
		PermissionModeID: strings.TrimSpace(input.Settings.PermissionModeID),
		PlanMode:         input.Settings.PlanMode,
		BrowserUse:       input.Settings.BrowserUse,
		ComputerUse:      input.Settings.ComputerUse,
		ReasoningEffort:  strings.TrimSpace(input.Settings.ReasoningEffort),
		Speed:            strings.TrimSpace(input.Settings.Speed),
	}
	if strings.TrimSpace(requestedSettings.PermissionModeID) == "" {
		requestedSettings.PermissionModeID = value(launchInput.PermissionModeID)
	}
	if requestedSettings.BrowserUse == nil {
		requestedSettings.BrowserUse = cloneBoolPointer(launchInput.BrowserUse)
	}
	if requestedSettings.ComputerUse == nil {
		requestedSettings.ComputerUse = cloneBoolPointer(launchInput.ComputerUse)
	}
	settings := normalizeComposerSettingsForProvider(provider, requestedSettings)
	if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		settings.Model = strings.TrimSpace(requestedSettings.Model)
		settings.PermissionModeID = strings.TrimSpace(requestedSettings.PermissionModeID)
		settings.PlanMode = requestedSettings.PlanMode
		settings.ReasoningEffort = strings.TrimSpace(requestedSettings.ReasoningEffort)
		settings.Speed = strings.TrimSpace(requestedSettings.Speed)
	}
	extensionProfile := ExtensionComposerProfile{}
	if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		var err error
		extensionProfile, err = s.extensionComposerProfileForLaunch(ctx, input.providerTargetRef)
		if err != nil {
			return ComposerOptions{}, err
		}
		input.extensionComposerProfile = extensionProfile
	}
	modelPlanResolution := modelPlanResolution{}
	if input.IgnoreModelPlanBinding {
		modelPlanResolution.ModelConfiguration = newProviderNativeModelConfiguration(
			provider,
			input.AgentTargetID,
		)
	} else if launchInput.ResolvedModelPlan != nil {
		requestedModel := settings.Model
		if requestedModel == "" {
			requestedModel = strings.TrimSpace(value(launchInput.Model))
			settings.Model = requestedModel
		}
		var err error
		modelPlanResolution, err = resolveProvidedModelPlan(
			provider,
			input.AgentTargetID,
			*launchInput.ResolvedModelPlan,
			launchInput.AgentDefaultModel,
			requestedModel,
		)
		if err != nil {
			return ComposerOptions{}, err
		}
	} else {
		modelPlanResolution = s.resolveModelPlan(
			ctx,
			input.WorkspaceID,
			input.AgentTargetID,
			provider,
			settings.Model,
		)
	}
	planEndpoint := modelPlanResolution.Endpoint
	if planEndpoint != nil {
		settings.Model = planEndpoint.Model
	}
	catalogProjection := composerModelCatalogProjection{}
	catalogProjectionOK := false
	if planEndpoint == nil && composerOptionsProviderUsesModelCatalog(provider) {
		catalogProjection, catalogProjectionOK = composerModelOptionsFromCatalog(
			ctx,
			s.ModelCatalog,
			provider,
			input.Cwd,
			settings.Model,
		)
	}
	defaultModel := composerConfiguredDefaultModel(provider)
	if catalogProjectionOK && catalogProjection.Selection.Found {
		settings.Model = strings.TrimSpace(catalogProjection.Selection.Model.ID)
		defaultModel = settings.Model
	}
	effectiveSettings := resolveComposerEffectiveSettings(
		provider,
		settings,
		defaultModel,
	)
	locale := normalizeComposerLocale(input.Locale)
	permissionConfig := composerPermissionConfig(provider, effectiveSettings.PermissionModeID, locale)
	if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		permissionProjection, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
			AgentTargetID: input.AgentTargetID,
			FallbackID:    effectiveSettings.PermissionModeID,
			Locale:        locale,
			Profile:       extensionProfile,
			Provider:      provider,
			SelectedID:    requestedPermissionModeID,
		})
		if err != nil {
			return ComposerOptions{}, err
		}
		logExtensionPermissionProjectionDiagnostics(permissionProjection, input.AgentTargetID, provider)
		permissionConfig = permissionProjection.Config
		effectiveSettings.PermissionModeID = permissionProjection.CurrentID
	}
	modelOptions := s.enrichModelCapabilityOptions(ctx, provider, composerSelectedModelOptions(effectiveSettings.Model))
	if composerProfileFor(provider).Behavior.ModelOptionsAuthoritative {
		modelOptions = []ComposerConfigOptionValue{}
	}
	reasoningOptions := composerReasoningOptionValues(provider, effectiveSettings.ReasoningEffort, locale)
	speedOptions := composerSpeedOptionValues(provider, locale)
	capabilities := composerProviderCapabilities(provider, s.computerUseAvailable())
	if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		capabilities = nil
	}
	runtimeContext := map[string]any{
		"capabilities":       capabilities,
		"configOptions":      composerConfigOptions(provider, effectiveSettings, modelOptions, reasoningOptions, speedOptions),
		"model":              nullableString(effectiveSettings.Model),
		"modelConfiguration": modelPlanResolution.ModelConfiguration.runtimeContext(),
		"permissionModeId":   nullableString(effectiveSettings.PermissionModeID),
		"reasoningEffort":    nullableString(effectiveSettings.ReasoningEffort),
		"speed":              nullableString(effectiveSettings.Speed),
	}
	commands := []ComposerCommandOption{}
	slashCommandPolicy := composerSlashCommandPolicy(provider)
	if policy := composerSlashCommandPolicyFromExtensionProfile(extensionProfile); policy != nil {
		slashCommandPolicy = policy
	}
	if providerTargetRefKind(input.providerTargetRef) != "agent_extension" {
		if runtimeCommands := filterComposerCommandsBySlashPolicy(s.composerCommandsFromRunningSession(
			input.WorkspaceID,
			provider,
			agentTargetID,
		), slashCommandPolicy); len(runtimeCommands) > 0 {
			commands = composerCommandOptions(runtimeCommands)
		}
	}
	if agentTargetID != "" {
		runtimeContext["agentTargetId"] = agentTargetID
	}
	if launchInput.WorkspaceAgentRevision > 0 {
		runtimeContext["workspaceAgentRevision"] = launchInput.WorkspaceAgentRevision
		runtimeContext["harnessAgentTargetId"] = launchInput.HarnessAgentTargetID
	}
	skills := filterWorkspaceAgentComposerSkills(
		s.discoverComposerSkillOptionsForLaunch(ctx, provider, input.Cwd, nil, input.providerTargetRef),
		launchInput.AgentSkills,
		launchInput.AgentCapabilitiesExplicit,
	)
	capabilityCatalog := []ComposerCapabilityOption{}
	capabilityErrors := []string(nil)
	if composerOptionsIncludeCapabilityCatalog(input) {
		capabilityCatalog, capabilityErrors = s.listComposerCapabilityOptions(ctx, provider, input.Cwd, skills)
		capabilityCatalog = filterWorkspaceAgentComposerCapabilities(
			capabilityCatalog,
			launchInput.AgentTools,
			launchInput.AgentCapabilitiesExplicit,
		)
	}
	runtimeContext["skills"] = composerSkillOptionsRuntimeContext(skills)
	if launchInput.WorkspaceAgentRevision > 0 {
		runtimeContext["workspaceAgent"] = map[string]any{
			"id":                   agentTargetID,
			"revision":             launchInput.WorkspaceAgentRevision,
			"harnessId":            launchInput.HarnessAgentTargetID,
			"name":                 strings.TrimSpace(launchInput.AgentName),
			"description":          strings.TrimSpace(launchInput.AgentDescription),
			"capabilitiesExplicit": launchInput.AgentCapabilitiesExplicit,
			"skills":               append([]string(nil), launchInput.AgentSkills...),
			"tools":                append([]string(nil), launchInput.AgentTools...),
		}
	}
	runtimeContext["capabilityCatalog"] = composerCapabilityOptionsRuntimeContext(capabilityCatalog)
	if len(capabilityErrors) > 0 {
		runtimeContext["capabilityCatalogErrors"] = capabilityErrors
	}
	reasoningOptionsByModel := map[string]ComposerReasoningProfile{}
	if catalogProjectionOK {
		modelOptions = s.enrichModelCapabilityOptions(ctx, provider, catalogProjection.ModelOptions)
		runtimeContext["modelCatalogSource"] = catalogProjection.Source
		if len(catalogProjection.ReasoningProfiles) > 0 {
			reasoningOptionsByModel = composerModelReasoningOptionsByModel(
				provider,
				locale,
				catalogProjection.ReasoningProfiles,
			)
		}
		selection := catalogProjection.Selection
		if selection.ReasoningEffortsAdvertised {
			effectiveSettings.ReasoningEffort = resolveAdvertisedReasoningEffort(
				provider,
				settings.ReasoningEffort,
				selection.DefaultReasoningEffort,
				selection.ReasoningEfforts,
			)
			reasoningOptions = composerAdvertisedReasoningOptionValues(
				provider,
				effectiveSettings.ReasoningEffort,
				locale,
				selection.ReasoningEfforts,
			)
			runtimeContext["reasoningEffort"] = nullableString(effectiveSettings.ReasoningEffort)
		}
		if selection.SpeedsAdvertised {
			effectiveSettings.Speed = resolveAdvertisedSpeed(
				settings.Speed,
				selection.DefaultSpeed,
				selection.Speeds,
			)
			speedOptions = composerAdvertisedSpeedOptionValues(locale, selection.Speeds)
			runtimeContext["speed"] = nullableString(effectiveSettings.Speed)
		}
		runtimeContext["configOptions"] = composerConfigOptions(provider, effectiveSettings, modelOptions, reasoningOptions, speedOptions)
	}
	options := ComposerOptions{
		Provider:                provider,
		Capabilities:            capabilities,
		Commands:                commands,
		ModelConfig:             composerModelConfig(provider, effectiveSettings.Model, modelOptions),
		PermissionConfig:        permissionConfig,
		ReasoningConfig:         composerReasoningConfigFromOptions(provider, effectiveSettings.ReasoningEffort, reasoningOptions),
		ReasoningOptionsByModel: reasoningOptionsByModel,
		SpeedConfig:             composerSpeedConfigFromOptions(provider, effectiveSettings.Speed, speedOptions),
		EffectiveSettings:       effectiveSettings,
		RuntimeContext:          runtimeContext,
		Skills:                  skills,
		CapabilityCatalog:       capabilityCatalog,
		Behavior:                composerProfileFor(provider).Behavior,
		SlashCommandPolicy:      slashCommandPolicy,
	}
	if planEndpoint == nil && (composerProfileFor(provider).LiveModelDiscovery ||
		providerTargetRefKind(input.providerTargetRef) == "agent_extension") {
		var err error
		options, err = s.mergeLiveComposerModelsForComposerOptions(ctx, input, effectiveSettings, options)
		if err != nil {
			return ComposerOptions{}, err
		}
	}
	if providerTargetRefKind(input.providerTargetRef) == "agent_extension" {
		var err error
		options, err = s.mergeRuntimeComposerContextForComposerOptions(
			input,
			effectiveSettings,
			locale,
			extensionProfile,
			requestedPermissionModeID,
			options,
		)
		if err != nil {
			return ComposerOptions{}, err
		}
		options = applyExtensionComposerCapabilities(options, extensionProfile)
	}
	options = applyResolvedModelPlanComposerOverlay(options, modelPlanResolution)
	return options, nil
}

func mergeComposerSettingsWithDefaults(
	requested ComposerSettings,
	defaults preferencesbiz.AgentComposerDefaults,
) ComposerSettings {
	if strings.TrimSpace(requested.Model) == "" {
		requested.Model = defaults.Model
	}
	if strings.TrimSpace(requested.PermissionModeID) == "" {
		requested.PermissionModeID = defaults.PermissionModeID
	}
	if strings.TrimSpace(requested.ReasoningEffort) == "" {
		requested.ReasoningEffort = defaults.ReasoningEffort
	}
	if strings.TrimSpace(requested.Speed) == "" {
		requested.Speed = defaults.Speed
	}
	return requested
}

func composerOptionsIncludeCapabilityCatalog(input ComposerOptionsInput) bool {
	return input.IncludeCapabilityCatalog == nil || *input.IncludeCapabilityCatalog
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
	return normalizeObservedComposerSettingsForProvider(provider, effective)
}

// composerDefaultSpeed returns the default speed tier for providers that expose
// the speed dimension; an empty string for providers that do not.
func composerDefaultSpeed(provider string) string {
	return strings.TrimSpace(composerProfileFor(provider).DefaultSpeed)
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
	speedOptions []ComposerConfigOptionValue,
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
				"options":      composerConfigOptionValuesToRuntimeOptions(reasoningOptions),
			})
		}
	}
	if profile.Speed {
		options = append(options, map[string]any{
			"currentValue": nullableString(settings.Speed),
			"id":           speedConfigOptionID(provider),
			"options":      composerConfigOptionValuesToRuntimeOptions(speedOptions),
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

func clampComposerPlanModeForLaunch(provider string, providerTargetRef map[string]any, planMode bool) bool {
	if providerTargetRefKind(providerTargetRef) == "agent_extension" {
		return planMode
	}
	return clampComposerPlanModeForProvider(provider, planMode)
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
			Requested:          option.Requested,
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
	// Bootstrap echo: the sole entry mirrors the requested/effective settings,
	// so it carries the requested provenance marker.
	return []ComposerConfigOptionValue{{ID: model, Label: model, Value: model, Requested: true}}
}

func reasoningConfigOptionID(provider string) string {
	return strings.TrimSpace(composerProfileFor(provider).ReasoningConfigOptionID)
}

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
	return append([]string(nil), composerProfileFor(provider).SpeedValues...)
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
	return strings.TrimSpace(composerProfileFor(provider).DefaultSpeed)
}

func composerSpeedOptionValues(provider string, locale string) []ComposerConfigOptionValue {
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
	return options
}

func composerSpeedConfigFromOptions(provider string, selected string, options []ComposerConfigOptionValue) ComposerConfigOption {
	selected = strings.TrimSpace(selected)
	return ComposerConfigOption{
		Configurable: speedProviderSupportsSpeed(provider) && len(options) > 0,
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      cloneComposerConfigOptionValues(options),
	}
}

func composerAdvertisedSpeedOptionValues(locale string, advertised []AgentModelSpeedOption) []ComposerConfigOptionValue {
	options := make([]ComposerConfigOptionValue, 0, len(advertised))
	for _, advertisedOption := range advertised {
		value := strings.TrimSpace(advertisedOption.Value)
		if value == "" {
			continue
		}
		label, description := speedDisplay(value, locale)
		if advertisedLabel := strings.TrimSpace(advertisedOption.Label); advertisedLabel != "" {
			label = advertisedLabel
		}
		if advertisedDescription := strings.TrimSpace(advertisedOption.Description); advertisedDescription != "" {
			description = advertisedDescription
		}
		options = append(options, ComposerConfigOptionValue{
			ID: value, Label: label, Value: value, Description: description,
		})
	}
	return options
}

func resolveAdvertisedSpeed(selected string, advertisedDefault string, advertised []AgentModelSpeedOption) string {
	selected = strings.TrimSpace(selected)
	advertisedDefault = strings.TrimSpace(advertisedDefault)
	firstValue := ""
	defaultSupported := false
	for _, option := range advertised {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		if firstValue == "" {
			firstValue = value
		}
		if value == selected {
			return selected
		}
		if value == advertisedDefault {
			defaultSupported = true
		}
	}
	if defaultSupported {
		return advertisedDefault
	}
	return firstValue
}
