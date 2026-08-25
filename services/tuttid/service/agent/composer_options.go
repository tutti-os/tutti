package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/composercatalog"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	"golang.org/x/sync/errgroup"
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
	Configurable   bool
	CurrentValue   string
	EffectiveValue string
	DefaultValue   string
	Options        []ComposerConfigOptionValue
}

type ComposerConfigOptionValue struct {
	Description                string
	ConsumptionMultiplier      string
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
	AgentSessionID           string
	AgentTargetID            string
	Cwd                      string
	Locale                   string
	Provider                 string
	WorkspaceID              string
	Settings                 ComposerSettings
	Section                  ComposerOptionsSection
	IncludeCapabilityCatalog *bool
	// WaitForFreshModelCatalog is reserved for an explicit model-picker open.
	// Ordinary composer loads may render the last successful list while the
	// daemon refreshes it asynchronously.
	WaitForFreshModelCatalog bool
	CodexSaverMode           *bool
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

// ComposerOptionsSection lets callers consume the independent parts of the
// composer catalog without making the model picker wait for app-server
// capability discovery. Full remains the compatibility behavior.
type ComposerOptionsSection string

const (
	ComposerOptionsSectionFull         ComposerOptionsSection = "full"
	ComposerOptionsSectionCore         ComposerOptionsSection = "core"
	ComposerOptionsSectionCapabilities ComposerOptionsSection = "capabilities"
	ComposerOptionsSectionConnectors   ComposerOptionsSection = "connectors"
)

func normalizeComposerOptionsSection(section ComposerOptionsSection) ComposerOptionsSection {
	switch section {
	case ComposerOptionsSectionCore, ComposerOptionsSectionCapabilities, ComposerOptionsSectionConnectors:
		return section
	default:
		return ComposerOptionsSectionFull
	}
}

func composerOptionsSectionIncludesCore(section ComposerOptionsSection) bool {
	return section == ComposerOptionsSectionFull || section == ComposerOptionsSectionCore
}

func composerOptionsSectionIncludesProviderCapabilities(section ComposerOptionsSection) bool {
	return section == ComposerOptionsSectionFull || section == ComposerOptionsSectionCapabilities
}

func composerOptionsSectionIncludesConnectors(section ComposerOptionsSection) bool {
	return section == ComposerOptionsSectionFull || section == ComposerOptionsSectionCapabilities || section == ComposerOptionsSectionConnectors
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

type ComposerCapabilityOption = composercatalog.Option

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
	CodexSaverModeSupported bool
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
	// liveModelDiscoveryPending distinguishes a temporarily unavailable live
	// catalog from an agent target that explicitly does not expose model
	// selection. It is daemon-internal and must not be serialized.
	liveModelDiscoveryPending bool
}

func (s *Service) GetComposerOptions(ctx context.Context, input ComposerOptionsInput) (ComposerOptions, error) {
	section := normalizeComposerOptionsSection(input.Section)
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
	if input.CodexSaverMode != nil {
		input.Settings.CodexSaverMode = *input.CodexSaverMode
	}
	codexSaverModeSupported := composerProviderSupportsSaverSubagentMode(provider)
	if !codexSaverModeSupported {
		input.Settings.CodexSaverMode = false
	}
	requestedSettings := ComposerSettings{
		CodexSaverMode:   input.Settings.CodexSaverMode,
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
	var catalogLoad <-chan composerModelCatalogLoadResult
	if composerOptionsSectionIncludesCore(section) && planEndpoint == nil && (composerOptionsProviderUsesModelCatalog(provider) ||
		(s.ReplayMode && s.ModelCatalog != nil)) {
		catalogLoad = startComposerModelCatalogLoad(
			ctx,
			s.ModelCatalog,
			provider,
			input.Cwd,
			settings.Model,
			input.WaitForFreshModelCatalog,
		)
	}
	skills := []ComposerSkillOption{}
	if composerOptionsSectionIncludesProviderCapabilities(section) {
		skills = filterWorkspaceAgentComposerSkills(
			s.discoverComposerSkillOptionsForLaunch(ctx, provider, input.Cwd, s.composerSessionEnv(input, provider), input.providerTargetRef),
			launchInput.AgentSkills,
			launchInput.AgentCapabilitiesExplicit,
		)
	}
	capabilityCatalog := []ComposerCapabilityOption{}
	capabilityErrors := []string(nil)
	if composerOptionsSectionIncludesConnectors(section) && composerOptionsIncludeCapabilityCatalog(input) {
		var (
			connectorsVisible   = true
			connectorVisibleErr error
			localConnectors     []ComposerCapabilityOption
			localConnectorsErr  error
		)
		capabilityGroup, capabilityContext := errgroup.WithContext(ctx)
		if composerOptionsSectionIncludesProviderCapabilities(section) {
			capabilityGroup.Go(func() error {
				capabilityCatalog, capabilityErrors = s.listComposerCapabilityOptions(capabilityContext, provider, input.Cwd, skills)
				return nil
			})
		}
		capabilityGroup.Go(func() error {
			connectorsVisible, connectorVisibleErr = s.connectorCatalogVisible(capabilityContext)
			return nil
		})
		if s.ConnectorMarketSnapshots != nil {
			capabilityGroup.Go(func() error {
				localConnectors, localConnectorsErr = localConnectorCapabilityOptions(
					capabilityContext,
					s.ConnectorMarketSnapshots,
					s.ConnectorMarketCurrentScope,
				)
				return nil
			})
		}
		_ = capabilityGroup.Wait()
		if connectorVisibleErr != nil {
			capabilityErrors = append(capabilityErrors, "load connector visibility: "+connectorVisibleErr.Error())
		}
		if !connectorsVisible {
			capabilityCatalog = replaceComposerConnectorCapabilities(capabilityCatalog, nil)
		} else if s.ConnectorMarketSnapshots != nil {
			if localConnectorsErr != nil {
				capabilityErrors = append(capabilityErrors, "load local connectors: "+localConnectorsErr.Error())
			}
			capabilityCatalog = replaceComposerConnectorCapabilities(capabilityCatalog, localConnectors)
		}
		capabilityCatalog = filterWorkspaceAgentComposerCapabilities(
			capabilityCatalog,
			launchInput.AgentTools,
			launchInput.AgentCapabilitiesExplicit,
		)
		skills = filterComposerSkillsRepresentedByCapabilityCatalog(skills, capabilityCatalog)
	}
	catalogProjection := composerModelCatalogProjection{}
	catalogProjectionOK := false
	if catalogLoad != nil {
		result := <-catalogLoad
		catalogProjection = result.projection
		catalogProjectionOK = result.ok
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
	capabilities := composerProviderCapabilities(provider, s.computerUseAvailable(), s.browserUseAvailable())
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
		if catalogProjection.Stale {
			// Keep the last known catalog visible while the daemon refreshes it in
			// the background. The activity adapter exposes this existing loading
			// signal so the picker can distinguish stale options from a settled
			// authoritative catalog.
			runtimeContext["appServerStartup"] = map[string]any{"models": "loading"}
		}
		if composerProfileFor(provider).ReasoningEffort && len(catalogProjection.ReasoningProfiles) > 0 {
			reasoningOptionsByModel = composerModelReasoningOptionsByModel(
				provider,
				locale,
				catalogProjection.ReasoningProfiles,
			)
		}
		selection := catalogProjection.Selection
		if composerProfileFor(provider).ReasoningEffort && selection.ReasoningEffortsAdvertised {
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
		if composerProfileFor(provider).Speed && selection.SpeedsAdvertised {
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
	if composerOptionsSectionIncludesCore(section) && planEndpoint == nil && !s.ReplayMode && (composerProfileFor(provider).LiveModelDiscovery ||
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
		options = applyExtensionComposerCapabilities(options, extensionProfile, s.computerUseAvailable(), s.browserUseAvailable())
	}
	options = applyResolvedModelPlanComposerOverlay(options, modelPlanResolution)
	options.CodexSaverModeSupported = codexSaverModeSupported
	return options, nil
}

func mergeComposerSettingsWithDefaults(
	requested ComposerSettings,
	defaults preferencesbiz.AgentComposerDefaults,
) ComposerSettings {
	if !requested.CodexSaverMode {
		requested.CodexSaverMode = defaults.CodexSaverMode
	}
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
		CodexSaverMode:   requested.CodexSaverMode,
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
		if err == nil && !result.Stale {
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
