package agent

import (
	"sort"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func (s *Service) mergeRuntimeComposerContextForComposerOptions(
	input ComposerOptionsInput,
	requestSettings ComposerSettings,
	locale string,
	extensionProfile ExtensionComposerProfile,
	requestedPermissionModeID string,
	options ComposerOptions,
) (ComposerOptions, error) {
	// The discovery cache signature belongs to the request that created the
	// hidden session. Runtime projection may already have selected a model or
	// mode, so deriving the key from options.EffectiveSettings here would turn
	// that result into a different cache key and make it unreachable.
	scope := newComposerLiveModelScopeForInput(input, requestSettings)
	runtimeContext := s.composerRuntimeContextFromSession(scope)
	capabilities := stringSliceFromAny(runtimeContext["capabilities"])
	if len(capabilities) == 0 {
		// Capability facts (image input, plan mode, ...) come from the agent
		// initialize handshake, so they are installation-scoped, not
		// project/settings-scoped. A composer without a scope-matching
		// session (home composer, fresh daemon) inherits them from the
		// newest session of the same extension installation.
		capabilities = s.extensionSessionCapabilitiesFallback(scope)
	}
	if len(runtimeContext) == 0 {
		if len(capabilities) > 0 {
			if options.RuntimeContext == nil {
				options.RuntimeContext = map[string]any{}
			}
			options.RuntimeContext["capabilities"] = capabilities
		}
		return options, nil
	}
	if options.RuntimeContext == nil {
		options.RuntimeContext = map[string]any{}
	}
	if len(capabilities) > 0 {
		options.RuntimeContext["capabilities"] = capabilities
	}
	if commands := filterComposerCommandsBySlashPolicy(
		composerCommandsFromRuntimeContext(runtimeContext),
		options.SlashCommandPolicy,
	); len(commands) > 0 {
		options.Commands = composerCommandOptions(commands)
		options.SlashCommandPolicy = composerSlashCommandPolicyFromCommands(
			options.SlashCommandPolicy,
			commands,
		)
	}
	configOptions := runtimeConfigOptionsAsMapSlice(runtimeContext["configOptions"])
	if len(configOptions) == 0 {
		return options, nil
	}
	options.RuntimeContext["configOptions"] = mergeRuntimeConfigOptions(
		runtimeConfigOptionsAsMapSlice(options.RuntimeContext["configOptions"]),
		configOptions,
	)
	configValues, _ := runtimeContext["config"].(map[string]any)
	if permissionOption, ok := runtimeConfigOptionByID(configOptions, extensionProfile.PermissionConfigOptionID); ok {
		projection, err := projectExtensionPermissionConfig(extensionPermissionProjectionInput{
			AgentTargetID: input.AgentTargetID,
			FallbackID:    requestSettings.PermissionModeID,
			Locale:        locale,
			Profile:       extensionProfile,
			Provider:      input.Provider,
			Runtime: &extensionPermissionRuntimeState{
				CurrentRuntimeID: runtimeConfigOptionCurrentValue(permissionOption, configValues),
				Options:          composerConfigOptionValuesFromAny(permissionOption["options"]),
			},
			SelectedID: requestedPermissionModeID,
		})
		if err != nil {
			return ComposerOptions{}, err
		}
		logExtensionPermissionProjectionDiagnostics(projection, input.AgentTargetID, input.Provider)
		options.PermissionConfig = projection.Config
		options.EffectiveSettings.PermissionModeID = projection.CurrentID
		options.RuntimeContext["permissionModeId"] = nullableString(projection.CurrentID)
	}
	if reasoningOption, ok := runtimeConfigOptionByID(configOptions, extensionProfile.ReasoningConfigOptionID); ok {
		if config, current := composerReasoningConfigFromRuntimeOption(
			reasoningOption,
			configValues,
			locale,
		); len(config.Options) > 0 {
			options.ReasoningConfig = config
			options.EffectiveSettings.ReasoningEffort = current
			options.RuntimeContext["reasoningEffort"] = nullableString(current)
		}
	}
	return options, nil
}

func (s *Service) composerRuntimeContextFromSession(
	scope composerLiveModelScope,
) map[string]any {
	scope.workspaceID = strings.TrimSpace(scope.workspaceID)
	scope.provider = agentprovider.NormalizeOpen(scope.provider)
	scope.agentTargetID = strings.TrimSpace(scope.agentTargetID)
	if scope.workspaceID == "" || scope.provider == "" {
		return nil
	}
	liveSessions := s.controller().Sessions(scope.workspaceID)
	sort.SliceStable(liveSessions, func(i, j int) bool {
		left := firstNonZeroInt64(liveSessions[i].UpdatedAtUnixMS, liveSessions[i].CreatedAtUnixMS)
		right := firstNonZeroInt64(liveSessions[j].UpdatedAtUnixMS, liveSessions[j].CreatedAtUnixMS)
		if left != right {
			return left > right
		}
		return liveSessions[i].ID > liveSessions[j].ID
	})
	for _, session := range liveSessions {
		if agentprovider.NormalizeOpen(session.Provider) != scope.provider {
			continue
		}
		if scope.agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != scope.agentTargetID {
			continue
		}
		if !scope.matchesExtensionRuntimeContext(session.RuntimeContext) {
			continue
		}
		if composerRuntimeContextHasComposerData(session.RuntimeContext) {
			return clonePayload(session.RuntimeContext)
		}
	}
	if cached, ok := s.getComposerRuntimeContextForScope(scope, time.Now().UTC()); ok {
		return cached
	}
	if s.SessionReader == nil {
		return nil
	}
	persisted, ok := s.SessionReader.ListSessions(scope.workspaceID)
	if !ok {
		return nil
	}
	var selected map[string]any
	var selectedUpdatedAt int64 = -1
	var selectedID string
	for _, session := range persisted {
		if agentprovider.NormalizeOpen(session.Provider) != scope.provider {
			continue
		}
		if scope.agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != scope.agentTargetID {
			continue
		}
		if !scope.matchesExtensionRuntimeContext(session.InternalRuntimeContext) ||
			!composerRuntimeContextHasComposerData(session.InternalRuntimeContext) {
			continue
		}
		updatedAt := firstNonZeroInt64(session.UpdatedAtUnixMS, session.CreatedAtUnixMS)
		if len(selected) > 0 && (updatedAt < selectedUpdatedAt || (updatedAt == selectedUpdatedAt && session.ID <= selectedID)) {
			continue
		}
		selected = clonePayload(session.InternalRuntimeContext)
		if len(session.Metadata.Capabilities) > 0 {
			// Persistence splits capabilities into session metadata; rejoin
			// them so a cold-start composer keeps the advertised list.
			selected["capabilities"] = append([]string(nil), session.Metadata.Capabilities...)
		}
		selectedUpdatedAt = updatedAt
		selectedID = session.ID
	}
	return selected
}

// extensionSessionCapabilitiesFallback returns the non-empty capability list
// advertised by the most recently created live or persisted session of the
// same provider and agent target, ignoring installation, project scope, and
// settings signature. Capability facts come from the agent initialize
// handshake, so candidates order by creation (handshake) time: updatedAt is
// bumped by read-side writes and says nothing about runtime facts. Local
// reinstalls rotate the installation id, so pinning the installation would
// invalidate the evidence on every reinstall; the result is still
// intersected with the current installation's declared capabilities by
// applyExtensionComposerCapabilities. The exact-scope lookup stays
// authoritative for config options and commands.
func (s *Service) extensionSessionCapabilitiesFallback(scope composerLiveModelScope) []string {
	if scope.workspaceID == "" || scope.provider == "" {
		return nil
	}
	liveSessions := s.controller().Sessions(scope.workspaceID)
	sort.SliceStable(liveSessions, func(i, j int) bool {
		if liveSessions[i].CreatedAtUnixMS != liveSessions[j].CreatedAtUnixMS {
			return liveSessions[i].CreatedAtUnixMS > liveSessions[j].CreatedAtUnixMS
		}
		return liveSessions[i].ID > liveSessions[j].ID
	})
	for _, session := range liveSessions {
		if agentprovider.NormalizeOpen(session.Provider) != scope.provider {
			continue
		}
		if scope.agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != scope.agentTargetID {
			continue
		}
		if capabilities := stringSliceFromAny(session.RuntimeContext["capabilities"]); len(capabilities) > 0 {
			return capabilities
		}
	}
	if s.SessionReader == nil {
		return nil
	}
	persisted, ok := s.SessionReader.ListSessions(scope.workspaceID)
	if !ok {
		return nil
	}
	var selected []string
	var selectedCreatedAt int64 = -1
	var selectedID string
	for _, session := range persisted {
		if agentprovider.NormalizeOpen(session.Provider) != scope.provider {
			continue
		}
		if scope.agentTargetID != "" && strings.TrimSpace(session.AgentTargetID) != scope.agentTargetID {
			continue
		}
		if len(session.Metadata.Capabilities) == 0 {
			continue
		}
		createdAt := session.CreatedAtUnixMS
		if len(selected) > 0 && (createdAt < selectedCreatedAt || (createdAt == selectedCreatedAt && session.ID <= selectedID)) {
			continue
		}
		selected = append([]string(nil), session.Metadata.Capabilities...)
		selectedCreatedAt = createdAt
		selectedID = session.ID
	}
	return selected
}

func composerRuntimeContextHasComposerData(runtimeContext map[string]any) bool {
	if len(runtimeContext) == 0 {
		return false
	}
	if len(runtimeConfigOptionsAsMapSlice(runtimeContext["configOptions"])) > 0 {
		return true
	}
	if len(composerCommandsFromRuntimeContext(runtimeContext)) > 0 {
		return true
	}
	return len(stringSliceFromAny(runtimeContext["capabilities"])) > 0
}

func mergeRuntimeConfigOptions(existing []map[string]any, runtimeOptions []map[string]any) []map[string]any {
	if len(existing) == 0 {
		return cloneRuntimeConfigOptions(runtimeOptions)
	}
	result := cloneRuntimeConfigOptions(existing)
	seen := make(map[string]struct{}, len(result))
	for _, option := range result {
		if id := strings.TrimSpace(stringFromAny(option["id"])); id != "" {
			seen[id] = struct{}{}
		}
	}
	for _, option := range runtimeOptions {
		id := strings.TrimSpace(stringFromAny(option["id"]))
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		result = append(result, clonePayload(option))
		seen[id] = struct{}{}
	}
	return result
}

func cloneRuntimeConfigOptions(options []map[string]any) []map[string]any {
	result := make([]map[string]any, 0, len(options))
	for _, option := range options {
		if len(option) == 0 {
			continue
		}
		result = append(result, clonePayload(option))
	}
	return result
}

func runtimeConfigOptionByID(options []map[string]any, ids ...string) (map[string]any, bool) {
	for _, option := range options {
		for _, id := range ids {
			if runtimeConfigOptionMatchesID(option, id) {
				return option, true
			}
		}
	}
	return nil, false
}

func runtimeConfigOptionMatchesID(option map[string]any, id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	return strings.TrimSpace(stringFromAny(option["id"])) == id ||
		strings.TrimSpace(stringFromAny(option["runtimeId"])) == id
}

func applyExtensionComposerCapabilities(options ComposerOptions, profile ExtensionComposerProfile) ComposerOptions {
	runtimeCapabilities := stringSliceFromAny(options.RuntimeContext["capabilities"])
	allowed := make(map[string]struct{}, len(profile.Capabilities))
	for _, capability := range profile.Capabilities {
		if capability = strings.TrimSpace(capability); providerregistry.IsKnownCapability(capability) {
			allowed[capability] = struct{}{}
		}
	}
	effective := make([]string, 0, len(runtimeCapabilities)+1)
	seen := map[string]struct{}{}
	for _, capability := range runtimeCapabilities {
		capability = strings.TrimSpace(capability)
		if _, ok := allowed[capability]; !ok {
			continue
		}
		if _, ok := seen[capability]; ok {
			continue
		}
		seen[capability] = struct{}{}
		effective = append(effective, capability)
	}
	if _, declared := allowed[providerregistry.CapabilitySkills]; declared && len(options.Skills) > 0 {
		if _, exists := seen[providerregistry.CapabilitySkills]; !exists {
			effective = append(effective, providerregistry.CapabilitySkills)
		}
	}
	options.Capabilities = effective
	options.RuntimeContext["capabilities"] = append([]string(nil), effective...)
	return options
}

func stringSliceFromAny(value any) []string {
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...)
	case []any:
		result := make([]string, 0, len(values))
		for _, item := range values {
			if text := strings.TrimSpace(stringFromAny(item)); text != "" {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func composerReasoningConfigFromRuntimeOption(
	option map[string]any,
	configValues map[string]any,
	locale string,
) (ComposerConfigOption, string) {
	values := composerConfigOptionValuesFromAny(option["options"])
	current := runtimeConfigOptionCurrentValue(option, configValues)
	if current == "" && len(values) > 0 {
		current = values[0].Value
	}
	config := ComposerConfigOption{
		Configurable: len(values) > 0,
		CurrentValue: current,
		DefaultValue: current,
		Options:      make([]ComposerConfigOptionValue, 0, len(values)),
	}
	for _, value := range values {
		optionValue := strings.TrimSpace(value.Value)
		if optionValue == "" {
			continue
		}
		label, description := reasoningEffortDisplay(optionValue, locale, value.Description)
		if text := strings.TrimSpace(value.Label); text != "" {
			label = text
		}
		config.Options = append(config.Options, ComposerConfigOptionValue{
			Description: description,
			ID:          optionValue,
			Label:       label,
			Value:       optionValue,
		})
	}
	if current == "" && len(config.Options) > 0 {
		current = config.Options[0].Value
		config.CurrentValue = current
		config.DefaultValue = current
	}
	return config, current
}

func runtimeConfigOptionCurrentValue(option map[string]any, configValues map[string]any) string {
	if value := strings.TrimSpace(stringFromAny(option["currentValue"])); value != "" {
		return value
	}
	id := strings.TrimSpace(stringFromAny(option["id"]))
	if id == "" {
		return ""
	}
	return strings.TrimSpace(stringFromAny(configValues[id]))
}

func composerSlashCommandPolicyFromCommands(
	existing *providerregistry.SlashCommandPolicyDescriptor,
	commands []map[string]any,
) *providerregistry.SlashCommandPolicyDescriptor {
	if existing != nil {
		return existing
	}
	names := make([]string, 0, len(commands))
	seen := map[string]struct{}{}
	for _, command := range commands {
		name := strings.TrimSpace(stringFromAny(command["name"]))
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil
	}
	return &providerregistry.SlashCommandPolicyDescriptor{
		FallbackCommands:            names,
		CommandCatalogAuthoritative: true,
	}
}

func composerSlashCommandPolicyFromExtensionProfile(
	profile ExtensionComposerProfile,
) *providerregistry.SlashCommandPolicyDescriptor {
	if len(profile.SlashCommands) == 0 {
		return nil
	}
	fallbackCommands := make([]string, 0, len(profile.SlashCommands))
	commandEffects := make([]providerregistry.SlashCommandEffectDescriptor, 0, len(profile.SlashCommands))
	seen := map[string]struct{}{}
	for _, command := range profile.SlashCommands {
		name := strings.TrimSpace(command.Name)
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		fallbackCommands = append(fallbackCommands, name)
		if effect := providerregistry.SlashCommandEffect(strings.TrimSpace(command.Effect)); effect != "" {
			commandEffects = append(commandEffects, providerregistry.SlashCommandEffectDescriptor{
				Command: name,
				Effect:  effect,
			})
		}
	}
	if len(fallbackCommands) == 0 && len(commandEffects) == 0 {
		return nil
	}
	return &providerregistry.SlashCommandPolicyDescriptor{
		FallbackCommands:            fallbackCommands,
		CommandCatalogAuthoritative: profile.SlashCommandCatalogAuthoritative,
		CommandEffects:              commandEffects,
	}
}

func filterComposerCommandsBySlashPolicy(
	commands []map[string]any,
	policy *providerregistry.SlashCommandPolicyDescriptor,
) []map[string]any {
	if len(commands) == 0 || policy == nil || !policy.CommandCatalogAuthoritative {
		return commands
	}
	allowed := map[string]struct{}{}
	for _, command := range policy.FallbackCommands {
		if name := strings.ToLower(strings.TrimSpace(command)); name != "" {
			allowed[name] = struct{}{}
		}
	}
	for _, effect := range policy.CommandEffects {
		if name := strings.ToLower(strings.TrimSpace(effect.Command)); name != "" {
			allowed[name] = struct{}{}
		}
	}
	if len(allowed) == 0 {
		return nil
	}
	filtered := make([]map[string]any, 0, len(commands))
	for _, command := range commands {
		name := strings.ToLower(strings.TrimSpace(stringFromAny(command["name"])))
		if _, ok := allowed[name]; ok {
			filtered = append(filtered, command)
		}
	}
	return filtered
}
