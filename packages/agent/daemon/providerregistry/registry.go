package providerregistry

import (
	"fmt"
	"strings"
)

var migratedDescriptors = []ProviderDescriptor{codexDescriptor(), claudeCodeDescriptor()}

var providerDescriptorIndex = buildProviderDescriptorIndex(migratedDescriptors)

var eventProviderIndex = buildEventProviderIndex(migratedDescriptors)

// Migrated returns the descriptors that have completed the provider-registry
// migration. Providers not present here continue through the explicitly
// temporary legacy registrations in their owning layers.
func Migrated() []ProviderDescriptor {
	result := make([]ProviderDescriptor, 0, len(migratedDescriptors))
	for _, descriptor := range migratedDescriptors {
		result = append(result, cloneDescriptor(descriptor))
	}
	return result
}

func Find(value string) (ProviderDescriptor, bool) {
	normalized := normalize(value)
	if normalized == "" {
		return ProviderDescriptor{}, false
	}
	index, ok := providerDescriptorIndex[normalized]
	if !ok {
		return ProviderDescriptor{}, false
	}
	return cloneDescriptor(migratedDescriptors[index]), true
}

// ResolveProviderID normalizes a migrated provider identity without exposing
// or cloning its descriptor. Use this in hot paths that only need identity.
func ResolveProviderID(value string) (string, bool) {
	index, ok := providerDescriptorIndex[normalize(value)]
	if !ok {
		return "", false
	}
	return migratedDescriptors[index].Identity.ID, true
}

// EventProvider describes the small immutable event-normalization projection
// consumed on per-event hot paths.
type EventProvider struct {
	ProviderID              string
	TurnLifecycleProjection TurnLifecycleProjectionPolicy
}

// ResolveEventProvider normalizes an event provider without cloning the full
// provider descriptor.
func ResolveEventProvider(value string) (EventProvider, bool) {
	resolved, ok := eventProviderIndex[normalize(value)]
	return resolved, ok
}

func ValidateMigrated() error {
	providerKeys := map[string]string{}
	eventKeys := map[string]string{}
	targetIDs := map[string]string{}
	for _, descriptor := range Migrated() {
		if err := Validate(descriptor); err != nil {
			return err
		}
		providerID := normalize(descriptor.Identity.ID)
		for _, key := range append([]string{providerID}, descriptor.Identity.Aliases...) {
			normalizedKey := normalize(key)
			if owner, exists := providerKeys[normalizedKey]; exists {
				return fmt.Errorf("provider key %q is shared by %q and %q", normalizedKey, owner, providerID)
			}
			providerKeys[normalizedKey] = providerID
		}
		if descriptor.Events.Enabled {
			for _, key := range append([]string{providerID}, descriptor.Events.Aliases...) {
				normalizedKey := normalize(key)
				if owner, exists := eventKeys[normalizedKey]; exists {
					return fmt.Errorf("event provider key %q is shared by %q and %q", normalizedKey, owner, providerID)
				}
				eventKeys[normalizedKey] = providerID
			}
		}
		targetID := strings.TrimSpace(descriptor.Target.ID)
		if owner, exists := targetIDs[targetID]; exists {
			return fmt.Errorf("target id %q is shared by %q and %q", targetID, owner, providerID)
		}
		targetIDs[targetID] = providerID
	}
	return nil
}

func Validate(descriptor ProviderDescriptor) error {
	providerID := normalize(descriptor.Identity.ID)
	if providerID == "" {
		return fmt.Errorf("provider identity id is required")
	}
	if descriptor.Identity.ID != providerID {
		return fmt.Errorf("provider identity id %q must be canonical", descriptor.Identity.ID)
	}
	if err := validateUniqueNonBlankStrings(descriptor.Identity.Aliases); err != nil {
		return fmt.Errorf("provider %q identity aliases: %w", providerID, err)
	}
	if containsNormalized(descriptor.Identity.Aliases, providerID) {
		return fmt.Errorf("provider %q identity aliases repeat its canonical id", providerID)
	}
	if strings.TrimSpace(descriptor.Identity.DisplayName) == "" {
		return fmt.Errorf("provider %q display name is required", providerID)
	}
	if strings.TrimSpace(descriptor.Identity.IconKey) == "" {
		return fmt.Errorf("provider %q icon key is required", providerID)
	}
	if strings.TrimSpace(descriptor.Identity.LocaleKey) == "" {
		return fmt.Errorf("provider %q locale key is required", providerID)
	}
	switch descriptor.Runtime.Kind {
	case RuntimeKindCodexAppServer, RuntimeKindClaudeSDK:
	case "":
		return fmt.Errorf("provider %q runtime kind is required", providerID)
	default:
		return fmt.Errorf("provider %q runtime kind %q is unsupported", providerID, descriptor.Runtime.Kind)
	}
	if strings.TrimSpace(descriptor.Runtime.Name) == "" {
		return fmt.Errorf("provider %q runtime name is required", providerID)
	}
	if descriptor.Runtime.Kind == RuntimeKindCodexAppServer {
		if strings.TrimSpace(descriptor.Runtime.ClientInfoName) == "" {
			return fmt.Errorf("provider %q runtime client info name is required", providerID)
		}
		if strings.TrimSpace(descriptor.Runtime.AuthRequiredMessage) == "" {
			return fmt.Errorf("provider %q runtime auth required message is required", providerID)
		}
		if err := validateCommand(descriptor.Runtime.Command); err != nil {
			return fmt.Errorf("provider %q runtime command: %w", providerID, err)
		}
	}
	switch descriptor.Runtime.Endpoint.ConfigKind {
	case "", EndpointConfigKindCodexCLI, EndpointConfigKindClaudeSettings:
	default:
		return fmt.Errorf("provider %q endpoint config kind %q is unsupported", providerID, descriptor.Runtime.Endpoint.ConfigKind)
	}
	switch descriptor.Status.Kind {
	case StatusKindCodexCLI, StatusKindClaudeCLI:
	case "":
		return fmt.Errorf("provider %q status kind is required", providerID)
	default:
		return fmt.Errorf("provider %q status kind %q is unsupported", providerID, descriptor.Status.Kind)
	}
	if descriptor.Status.Kind == StatusKindCodexCLI && strings.TrimSpace(descriptor.Status.MinVersion) == "" {
		return fmt.Errorf("provider %q minimum version is required", providerID)
	}
	if descriptor.Status.AuthStatusCommandTimeoutSeconds < 0 {
		return fmt.Errorf("provider %q auth status timeout must be non-negative", providerID)
	}
	if len(descriptor.Status.BinaryNames) == 0 {
		return fmt.Errorf("provider %q status binary names are required", providerID)
	}
	if err := validateUniqueNonBlankStrings(descriptor.Status.BinaryNames); err != nil {
		return fmt.Errorf("provider %q status binary names: %w", providerID, err)
	}
	if err := validateCommand(descriptor.Status.AuthStatusCommand); err != nil {
		return fmt.Errorf("provider %q auth status command: %w", providerID, err)
	}
	if len(descriptor.Status.AuthMarkerPaths) == 0 {
		return fmt.Errorf("provider %q auth marker paths are required", providerID)
	}
	if err := validateUniqueNonBlankStrings(descriptor.Status.AuthMarkerPaths); err != nil {
		return fmt.Errorf("provider %q auth marker paths: %w", providerID, err)
	}
	if err := validateCommand(descriptor.Status.LoginArgs); err != nil {
		return fmt.Errorf("provider %q login args: %w", providerID, err)
	}
	switch descriptor.Status.Install.Kind {
	case InstallerKindCodexCLILatest:
		if strings.TrimSpace(descriptor.Status.NPMRegistryPackage) == "" {
			return fmt.Errorf("provider %q npm registry package is required", providerID)
		}
		if strings.TrimSpace(descriptor.Status.Install.PackageName) == "" {
			return fmt.Errorf("provider %q installer package name is required", providerID)
		}
		if strings.TrimSpace(descriptor.Status.Install.BinaryName) == "" {
			return fmt.Errorf("provider %q installer binary name is required", providerID)
		}
		if descriptor.Status.Install.PackageName != descriptor.Status.NPMRegistryPackage {
			return fmt.Errorf(
				"provider %q installer package %q does not match npm registry package %q",
				providerID,
				descriptor.Status.Install.PackageName,
				descriptor.Status.NPMRegistryPackage,
			)
		}
	case InstallerKindOfficialScript:
		if strings.TrimSpace(descriptor.Status.Install.ScriptURL) == "" {
			return fmt.Errorf("provider %q installer script url is required", providerID)
		}
		if strings.TrimSpace(descriptor.Status.Install.ScriptShell) == "" {
			return fmt.Errorf("provider %q installer script shell is required", providerID)
		}
	case "":
		return fmt.Errorf("provider %q installer kind is required", providerID)
	default:
		return fmt.Errorf("provider %q installer kind %q is unsupported", providerID, descriptor.Status.Install.Kind)
	}
	if strings.TrimSpace(descriptor.Status.Install.DisplayCommand) == "" {
		return fmt.Errorf("provider %q installer display command is required", providerID)
	}
	if len(descriptor.Status.AuthWatch.Paths) > 0 || len(descriptor.Status.AuthWatch.HomePaths) > 0 {
		if strings.TrimSpace(descriptor.Status.AuthWatch.RootEnvVar) == "" &&
			strings.TrimSpace(descriptor.Status.AuthWatch.DefaultRoot) == "" {
			return fmt.Errorf("provider %q auth watch root is required", providerID)
		}
		if err := validateUniqueNonBlankStrings(descriptor.Status.AuthWatch.Paths); err != nil {
			return fmt.Errorf("provider %q auth watch paths: %w", providerID, err)
		}
		if err := validateUniqueNonBlankStrings(descriptor.Status.AuthWatch.HomePaths); err != nil {
			return fmt.Errorf("provider %q auth watch home paths: %w", providerID, err)
		}
		switch descriptor.Status.AuthWatch.FingerprintKind {
		case AuthWatchFingerprintNone, AuthWatchFingerprintClaudeState:
		default:
			return fmt.Errorf("provider %q auth watch fingerprint kind %q is unsupported", providerID, descriptor.Status.AuthWatch.FingerprintKind)
		}
	}
	switch descriptor.ComposerProfile.ModelCatalog {
	case "", ModelCatalogKindCodexCLI:
	default:
		return fmt.Errorf("provider %q model catalog kind %q is unsupported", providerID, descriptor.ComposerProfile.ModelCatalog)
	}
	switch descriptor.ComposerProfile.CapabilityCatalog.Kind {
	case "", CapabilityCatalogKindCodexAppServer:
	default:
		return fmt.Errorf("provider %q capability catalog kind %q is unsupported", providerID, descriptor.ComposerProfile.CapabilityCatalog.Kind)
	}
	switch descriptor.ComposerProfile.Skills.Kind {
	case SkillKindCodex, SkillKindClaudeCode:
	default:
		return fmt.Errorf("provider %q skill kind %q is unsupported", providerID, descriptor.ComposerProfile.Skills.Kind)
	}
	switch descriptor.ComposerProfile.LiveModelDiscovery.Kind {
	case "", LiveModelDiscoveryKindClaudeSDK:
	default:
		return fmt.Errorf("provider %q live model discovery kind %q is unsupported", providerID, descriptor.ComposerProfile.LiveModelDiscovery.Kind)
	}
	if descriptor.ComposerProfile.LiveModelDiscovery.Kind != "" && descriptor.ComposerProfile.ModelCatalog != "" {
		return fmt.Errorf("provider %q cannot declare both live model discovery and a model catalog", providerID)
	}
	switch descriptor.ComposerProfile.Skills.Invocation {
	case SkillInvocationPromptItem, SkillInvocationTextTrigger:
	default:
		return fmt.Errorf("provider %q skill invocation %q is unsupported", providerID, descriptor.ComposerProfile.Skills.Invocation)
	}
	if err := validateSlashCommandPolicy(descriptor.ComposerProfile.SlashCommandPolicy); err != nil {
		return fmt.Errorf("provider %q slash command policy: %w", providerID, err)
	}
	if strings.TrimSpace(descriptor.Target.ID) == "" {
		return fmt.Errorf("provider %q target id is required", providerID)
	}
	switch strings.TrimSpace(descriptor.Target.LaunchRefType) {
	case TargetLaunchRefTypeLocalCLI:
	default:
		return fmt.Errorf("provider %q target launch ref type %q is unsupported", providerID, descriptor.Target.LaunchRefType)
	}
	if descriptor.Target.SortOrder < 0 {
		return fmt.Errorf("provider %q target sort order must be non-negative", providerID)
	}
	if !descriptor.Events.Enabled {
		return fmt.Errorf("provider %q event normalization must be enabled", providerID)
	}
	if err := validateUniqueNonBlankStrings(descriptor.Events.Aliases); err != nil {
		return fmt.Errorf("provider %q event aliases: %w", providerID, err)
	}
	if containsNormalized(descriptor.Events.Aliases, providerID) {
		return fmt.Errorf("provider %q event aliases repeat its canonical id", providerID)
	}
	switch descriptor.Events.TurnLifecycleProjection {
	case TurnLifecycleProjectionLegacy, TurnLifecycleProjectionExplicit:
	default:
		return fmt.Errorf("provider %q turn lifecycle projection policy %q is unsupported", providerID, descriptor.Events.TurnLifecycleProjection)
	}
	if descriptor.ComposerProfile.PermissionConfigurable && len(descriptor.ComposerProfile.PermissionModes) == 0 {
		return fmt.Errorf("provider %q configurable permissions require modes", providerID)
	}
	if descriptor.ComposerProfile.ModelSelection && strings.TrimSpace(descriptor.ComposerProfile.ConfigOptionIDs.Model) == "" {
		return fmt.Errorf("provider %q model selection requires a config option id", providerID)
	}
	if descriptor.ComposerProfile.ReasoningEffort && strings.TrimSpace(descriptor.ComposerProfile.ConfigOptionIDs.Reasoning) == "" {
		return fmt.Errorf("provider %q reasoning requires a config option id", providerID)
	}
	if descriptor.ComposerProfile.Speed && strings.TrimSpace(descriptor.ComposerProfile.ConfigOptionIDs.Speed) == "" {
		return fmt.Errorf("provider %q speed requires a config option id", providerID)
	}
	defaultPermissionModeID := strings.TrimSpace(descriptor.ComposerProfile.DefaultPermissionModeID)
	if defaultPermissionModeID != "" {
		found := false
		for _, mode := range descriptor.ComposerProfile.PermissionModes {
			if strings.TrimSpace(mode.ID) == defaultPermissionModeID {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("provider %q default permission mode %q is not declared", providerID, defaultPermissionModeID)
		}
	}
	return nil
}

func validateCommand(command []string) error {
	if len(command) == 0 {
		return fmt.Errorf("is required")
	}
	for index, argument := range command {
		if strings.TrimSpace(argument) == "" {
			return fmt.Errorf("argument %d is empty", index)
		}
	}
	return nil
}

func validateUniqueNonBlankStrings(values []string) error {
	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		normalized := normalize(value)
		if normalized == "" {
			return fmt.Errorf("entry %d is empty", index)
		}
		if _, ok := seen[normalized]; ok {
			return fmt.Errorf("entry %q is duplicated", strings.TrimSpace(value))
		}
		seen[normalized] = struct{}{}
	}
	return nil
}

func containsNormalized(values []string, expected string) bool {
	for _, value := range values {
		if normalize(value) == expected {
			return true
		}
	}
	return false
}

func validateSlashCommandPolicy(policy SlashCommandPolicyDescriptor) error {
	if err := validateUniqueNonBlankStrings(policy.FallbackCommands); err != nil {
		return fmt.Errorf("fallback commands: %w", err)
	}
	seen := make(map[string]struct{}, len(policy.CommandEffects))
	for index, descriptor := range policy.CommandEffects {
		command := normalize(descriptor.Command)
		if command == "" {
			return fmt.Errorf("command effect %d command is empty", index)
		}
		if _, ok := seen[command]; ok {
			return fmt.Errorf("command effect for %q is duplicated", command)
		}
		seen[command] = struct{}{}
		switch descriptor.Effect {
		case SlashCommandEffectSubmitImmediate,
			SlashCommandEffectShowReviewPicker,
			SlashCommandEffectActivateGoalMode,
			SlashCommandEffectTogglePlanMode,
			SlashCommandEffectShowStatus,
			SlashCommandEffectToggleSpeed:
		default:
			return fmt.Errorf("command %q effect %q is unsupported", command, descriptor.Effect)
		}
	}
	return nil
}

func normalize(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func buildProviderDescriptorIndex(descriptors []ProviderDescriptor) map[string]int {
	result := make(map[string]int, len(descriptors))
	for index, descriptor := range descriptors {
		for _, key := range append([]string{descriptor.Identity.ID}, descriptor.Identity.Aliases...) {
			result[normalize(key)] = index
		}
	}
	return result
}

func buildEventProviderIndex(descriptors []ProviderDescriptor) map[string]EventProvider {
	result := make(map[string]EventProvider, len(descriptors))
	for _, descriptor := range descriptors {
		if !descriptor.Events.Enabled {
			continue
		}
		resolved := EventProvider{
			ProviderID:              descriptor.Identity.ID,
			TurnLifecycleProjection: descriptor.Events.TurnLifecycleProjection,
		}
		for _, key := range append([]string{descriptor.Identity.ID}, descriptor.Events.Aliases...) {
			result[normalize(key)] = resolved
		}
	}
	return result
}

func cloneDescriptor(value ProviderDescriptor) ProviderDescriptor {
	value.Identity.Aliases = append([]string(nil), value.Identity.Aliases...)
	value.Runtime.Command = append([]string(nil), value.Runtime.Command...)
	value.Runtime.Endpoint.BaseURLEnvVars = append([]string(nil), value.Runtime.Endpoint.BaseURLEnvVars...)
	value.Status.BinaryNames = append([]string(nil), value.Status.BinaryNames...)
	value.Status.AdapterBinaryNames = append([]string(nil), value.Status.AdapterBinaryNames...)
	value.Status.AuthStatusCommand = append([]string(nil), value.Status.AuthStatusCommand...)
	value.Status.AuthMarkerPaths = append([]string(nil), value.Status.AuthMarkerPaths...)
	value.Status.APIEndpoints = append([]string(nil), value.Status.APIEndpoints...)
	value.Status.CustomConfigEnvVars = append([]string(nil), value.Status.CustomConfigEnvVars...)
	value.Status.CredentialEnvVars = append([]string(nil), value.Status.CredentialEnvVars...)
	value.Status.LoginArgs = append([]string(nil), value.Status.LoginArgs...)
	value.Status.AuthWatch.Paths = append([]string(nil), value.Status.AuthWatch.Paths...)
	value.Status.AuthWatch.HomePaths = append([]string(nil), value.Status.AuthWatch.HomePaths...)
	value.ComposerProfile.ReasoningEffortValues = append([]string(nil), value.ComposerProfile.ReasoningEffortValues...)
	value.ComposerProfile.Capabilities = append([]string(nil), value.ComposerProfile.Capabilities...)
	value.ComposerProfile.PermissionModes = append([]PermissionModeDescriptor(nil), value.ComposerProfile.PermissionModes...)
	value.ComposerProfile.SlashCommandPolicy.FallbackCommands = append([]string(nil), value.ComposerProfile.SlashCommandPolicy.FallbackCommands...)
	value.ComposerProfile.SlashCommandPolicy.CommandEffects = append([]SlashCommandEffectDescriptor(nil), value.ComposerProfile.SlashCommandPolicy.CommandEffects...)
	value.Events.Aliases = append([]string(nil), value.Events.Aliases...)
	return value
}
