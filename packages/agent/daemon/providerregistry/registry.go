package providerregistry

import (
	"fmt"
	"regexp"
	"strings"

	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

var migratedDescriptors = []ProviderDescriptor{
	codexDescriptor(),
	claudeCodeDescriptor(),
	cursorDescriptor(),
	tuttiAgentDescriptor(),
	openCodeDescriptor(),
	nexightDescriptor(),
	openClawDescriptor(),
}

var providerDescriptorIndex = buildProviderDescriptorIndex(migratedDescriptors)

var eventProviderIndex = buildEventProviderIndex(migratedDescriptors)

// Descriptor-owned compatibility floors intentionally accept stable releases
// only. The daemon's lightweight comparator does not implement full SemVer
// pre-release precedence, so allowing a pre-release floor would make the gate
// ambiguous.
var minimumVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

func canonicalProviderIdentity(providerID string) IdentityDescriptor {
	identity, ok := canonical.FindProviderIdentity(providerID)
	if !ok {
		panic("missing canonical provider identity: " + providerID)
	}
	return identity
}

// Migrated returns the complete provider descriptor catalog.
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

// ResolveModelPlanProtocol returns the model API protocol declared by a
// migrated provider runtime. Providers without endpoint injection support are
// intentionally unresolved.
func ResolveModelPlanProtocol(value string) (ModelPlanProtocol, bool) {
	index, ok := providerDescriptorIndex[normalize(value)]
	if !ok {
		return "", false
	}
	protocol := migratedDescriptors[index].Runtime.Endpoint.ModelPlanProtocol
	return protocol, protocol != ""
}

// ResolveModelPlanModelAddressing returns the composer/settings addressing a
// migrated provider runtime declares for bound plan models. The empty value
// (raw plan model ids) resolves as unset.
func ResolveModelPlanModelAddressing(value string) (ModelPlanModelAddressing, bool) {
	index, ok := providerDescriptorIndex[normalize(value)]
	if !ok {
		return "", false
	}
	addressing := migratedDescriptors[index].Runtime.Endpoint.ModelPlanModelAddressing
	return addressing, addressing != ""
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
	if err := validateNativeSubscriptions(Migrated()); err != nil {
		return err
	}
	providerKeys := map[string]string{}
	eventKeys := map[string]string{}
	targetIDs := map[string]string{}
	defaultProviderPriorities := map[int]string{}
	statusProbePriorities := map[int]string{}
	managedOrders := map[int]string{}
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
		if priority := descriptor.Desktop.DefaultProviderPriority; priority > 0 {
			if owner, exists := defaultProviderPriorities[priority]; exists {
				return fmt.Errorf("desktop default provider priority %d is shared by %q and %q", priority, owner, providerID)
			}
			defaultProviderPriorities[priority] = providerID
		}
		if priority := descriptor.Desktop.StatusProbePriority; priority > 0 {
			if owner, exists := statusProbePriorities[priority]; exists {
				return fmt.Errorf("desktop status probe priority %d is shared by %q and %q", priority, owner, providerID)
			}
			statusProbePriorities[priority] = providerID
		}
		if order := descriptor.Desktop.ManagedOrder; order > 0 {
			if owner, exists := managedOrders[order]; exists {
				return fmt.Errorf("desktop managed order %d is shared by %q and %q", order, owner, providerID)
			}
			managedOrders[order] = providerID
		}
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
	switch descriptor.Sidecar.MentionRouting {
	case "", SidecarMentionRoutingClaudeNamespaced:
	default:
		return fmt.Errorf("provider %q sidecar mention routing %q is unsupported", providerID, descriptor.Sidecar.MentionRouting)
	}
	switch descriptor.Sidecar.ExecutionEnvironment {
	case SidecarExecutionEnvironmentCodexSandbox, SidecarExecutionEnvironmentClaudeIPC, SidecarExecutionEnvironmentLocalIPC:
	case "":
		return fmt.Errorf("provider %q sidecar execution environment is required", providerID)
	default:
		return fmt.Errorf("provider %q sidecar execution environment %q is unsupported", providerID, descriptor.Sidecar.ExecutionEnvironment)
	}
	if skillRoot := strings.TrimSpace(descriptor.Sidecar.SkillRoot); skillRoot != "" {
		normalizedSkillRoot := strings.ReplaceAll(skillRoot, "\\", "/")
		if strings.HasPrefix(normalizedSkillRoot, "/") || containsNormalized(strings.Split(normalizedSkillRoot, "/"), "..") {
			return fmt.Errorf("provider %q sidecar skill root %q must stay relative", providerID, descriptor.Sidecar.SkillRoot)
		}
	}
	switch descriptor.Desktop.UsageProbeKind {
	case "", DesktopUsageProbeCodex, DesktopUsageProbeClaudeCode:
	default:
		return fmt.Errorf("provider %q desktop usage probe kind %q is unsupported", providerID, descriptor.Desktop.UsageProbeKind)
	}
	switch descriptor.Desktop.VisibilityGate {
	case "", DesktopVisibilityGateTuttiAgent:
	default:
		return fmt.Errorf("provider %q desktop visibility gate %q is unsupported", providerID, descriptor.Desktop.VisibilityGate)
	}
	switch descriptor.Desktop.RuntimeProbeFallback {
	case "", DesktopRuntimeProbeFallbackDirect:
	default:
		return fmt.Errorf("provider %q desktop runtime probe fallback %q is unsupported", providerID, descriptor.Desktop.RuntimeProbeFallback)
	}
	if descriptor.Desktop.UnavailableDockOrderOffset < 0 {
		return fmt.Errorf("provider %q desktop unavailable dock order offset must be non-negative", providerID)
	}
	if descriptor.Desktop.StatusProbePriority < 0 {
		return fmt.Errorf("provider %q desktop status probe priority must be non-negative", providerID)
	}
	if descriptor.Desktop.ManagedOrder < 0 {
		return fmt.Errorf("provider %q desktop managed order must be non-negative", providerID)
	}
	if descriptor.Desktop.Managed != (descriptor.Desktop.ManagedOrder > 0) {
		return fmt.Errorf("provider %q desktop managed status and order must be declared together", providerID)
	}
	if descriptor.Desktop.Managed != (descriptor.Desktop.StatusProbePriority > 0) {
		return fmt.Errorf("provider %q desktop managed status and probe priority must be declared together", providerID)
	}
	if !descriptor.Desktop.Managed && (descriptor.Desktop.InstallBootstrap || descriptor.Desktop.RefreshOnAccountChange) {
		return fmt.Errorf("provider %q desktop bootstrap and account refresh require managed status", providerID)
	}
	if descriptor.Desktop.DefaultProviderPriority < 0 {
		return fmt.Errorf("provider %q desktop default provider priority must be non-negative", providerID)
	}
	if descriptor.Desktop.DefaultProviderEligible != (descriptor.Desktop.DefaultProviderPriority > 0) {
		return fmt.Errorf("provider %q desktop default eligibility and priority must be declared together", providerID)
	}
	if err := validateExternalImportDescriptor(descriptor.ExternalImport); err != nil {
		return fmt.Errorf("provider %q external import: %w", providerID, err)
	}
	switch descriptor.Runtime.Kind {
	case RuntimeKindCodexAppServer:
		if strings.TrimSpace(descriptor.Runtime.ClientInfoName) == "" {
			return fmt.Errorf("provider %q runtime client info name is required", providerID)
		}
	case RuntimeKindStandardACP:
		if err := validateStandardACPRuntime(descriptor.Runtime.StandardACP); err != nil {
			return fmt.Errorf("provider %q standard ACP runtime: %w", providerID, err)
		}
	case RuntimeKindClaudeSDK:
	case "":
		return fmt.Errorf("provider %q runtime kind is required", providerID)
	default:
		return fmt.Errorf("provider %q runtime kind %q is unsupported", providerID, descriptor.Runtime.Kind)
	}
	switch descriptor.Status.SupportStatus {
	case "", "available":
	case "unsupported":
		if strings.TrimSpace(descriptor.Status.DisabledReasonCode) == "" {
			return fmt.Errorf("provider %q unsupported status requires a disabled reason", providerID)
		}
	default:
		return fmt.Errorf("provider %q support status %q is unsupported", providerID, descriptor.Status.SupportStatus)
	}
	if strings.TrimSpace(descriptor.Runtime.Name) == "" {
		return fmt.Errorf("provider %q runtime name is required", providerID)
	}
	if descriptor.Runtime.Kind == RuntimeKindCodexAppServer || descriptor.Runtime.Kind == RuntimeKindStandardACP {
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
	switch descriptor.Runtime.Endpoint.ModelPlanProtocol {
	case "", ModelPlanProtocolOpenAI, ModelPlanProtocolAnthropic:
	default:
		return fmt.Errorf("provider %q model plan protocol %q is unsupported", providerID, descriptor.Runtime.Endpoint.ModelPlanProtocol)
	}
	switch descriptor.Runtime.Endpoint.ModelPlanModelAddressing {
	case "", ModelPlanModelAddressingProviderPrefixed:
	default:
		return fmt.Errorf("provider %q model plan model addressing %q is unsupported", providerID, descriptor.Runtime.Endpoint.ModelPlanModelAddressing)
	}
	if descriptor.Runtime.Endpoint.ModelPlanModelAddressing != "" && descriptor.Runtime.Endpoint.ModelPlanProtocol == "" {
		return fmt.Errorf("provider %q model plan model addressing requires a model plan protocol", providerID)
	}
	hasModelPlanProtocol := descriptor.Runtime.Endpoint.ModelPlanProtocol != ""
	hasModelPlanCapability := containsNormalized(descriptor.ComposerProfile.Capabilities, normalize(CapabilityModelPlanBinding))
	if hasModelPlanProtocol != hasModelPlanCapability {
		return fmt.Errorf("provider %q model plan protocol and capability must be declared together", providerID)
	}
	switch descriptor.Status.Kind {
	case StatusKindCodexCLI, StatusKindClaudeCLI, StatusKindOpenCodeCLI, StatusKindGenericCLI:
	case "":
		return fmt.Errorf("provider %q status kind is required", providerID)
	default:
		return fmt.Errorf("provider %q status kind %q is unsupported", providerID, descriptor.Status.Kind)
	}
	switch descriptor.Status.AuthOutputParserKind {
	case AuthOutputParserKindCodex, AuthOutputParserKindClaude, AuthOutputParserKindOpenCode, AuthOutputParserKindCursor:
	case "":
		if descriptor.Status.SupportStatus != "unsupported" && len(descriptor.Status.AuthStatusCommand) > 0 {
			return fmt.Errorf("provider %q auth output parser kind is required", providerID)
		}
	default:
		return fmt.Errorf("provider %q auth output parser kind %q is unsupported", providerID, descriptor.Status.AuthOutputParserKind)
	}
	switch descriptor.Status.AuthMarkerParserKind {
	case AuthMarkerParserKindFileExists, AuthMarkerParserKindClaude, AuthMarkerParserKindTuttiToken:
	default:
		return fmt.Errorf("provider %q auth marker parser kind %q is unsupported", providerID, descriptor.Status.AuthMarkerParserKind)
	}
	switch descriptor.Status.AuthCommandRunnerKind {
	case AuthCommandRunnerKindGeneric, AuthCommandRunnerKindClaudeGate, AuthCommandRunnerKindCursor:
	default:
		return fmt.Errorf("provider %q auth command runner kind %q is unsupported", providerID, descriptor.Status.AuthCommandRunnerKind)
	}
	switch descriptor.Status.StaticSpecResolverKind {
	case StaticSpecResolverKindGeneric, StaticSpecResolverKindManagedNode, StaticSpecResolverKindCursor:
	default:
		return fmt.Errorf("provider %q static spec resolver kind %q is unsupported", providerID, descriptor.Status.StaticSpecResolverKind)
	}
	minimumVersion := strings.TrimSpace(descriptor.Status.MinVersion)
	if descriptor.Status.Kind == StatusKindCodexCLI && minimumVersion == "" {
		return fmt.Errorf("provider %q minimum version is required", providerID)
	}
	if minimumVersion != "" {
		if !minimumVersionPattern.MatchString(minimumVersion) {
			return fmt.Errorf("provider %q minimum version %q is invalid", providerID, descriptor.Status.MinVersion)
		}
		if descriptor.Status.Install.Kind == "" {
			return fmt.Errorf("provider %q minimum version requires an installer", providerID)
		}
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
	if descriptor.Status.SupportStatus != "unsupported" {
		if err := validateCommand(descriptor.Status.AuthStatusCommand); err != nil {
			return fmt.Errorf("provider %q auth status command: %w", providerID, err)
		}
	} else if len(descriptor.Status.AuthStatusCommand) > 0 {
		if err := validateCommand(descriptor.Status.AuthStatusCommand); err != nil {
			return fmt.Errorf("provider %q auth status command: %w", providerID, err)
		}
	}
	if len(descriptor.Status.AuthMarkerPaths) == 0 {
		return fmt.Errorf("provider %q auth marker paths are required", providerID)
	}
	if err := validateUniqueNonBlankStrings(descriptor.Status.AuthMarkerPaths); err != nil {
		return fmt.Errorf("provider %q auth marker paths: %w", providerID, err)
	}
	if descriptor.Status.SupportStatus != "unsupported" {
		if err := validateCommand(descriptor.Status.LoginArgs); err != nil {
			return fmt.Errorf("provider %q login args: %w", providerID, err)
		}
	} else if len(descriptor.Status.LoginArgs) > 0 {
		if err := validateCommand(descriptor.Status.LoginArgs); err != nil {
			return fmt.Errorf("provider %q login args: %w", providerID, err)
		}
	}
	if descriptor.Status.LoginActionKind != "" && descriptor.Status.LoginActionKind != StatusActionKindDaemon {
		return fmt.Errorf("provider %q login action kind %q is invalid", providerID, descriptor.Status.LoginActionKind)
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
			return fmt.Errorf("provider %q installer script URL is required", providerID)
		}
		if strings.TrimSpace(descriptor.Status.Install.ScriptShell) == "" {
			return fmt.Errorf("provider %q installer script shell is required", providerID)
		}
	case InstallerKindManagedNPM:
		if strings.TrimSpace(descriptor.Status.Install.PackageName) == "" || strings.TrimSpace(descriptor.Status.Install.BinaryName) == "" {
			return fmt.Errorf("provider %q managed npm installer package and binary are required", providerID)
		}
		managedDescriptor, _ := descriptor.ManagedNPMDescriptor()
		if err := managedDescriptor.Validate(); err != nil {
			return fmt.Errorf("provider %q managed npm installer: %w", providerID, err)
		}
	case InstallerKindShellCommand:
		if strings.TrimSpace(descriptor.Status.Install.ShellCommand) == "" {
			return fmt.Errorf("provider %q shell installer command is required", providerID)
		}
	case "":
		if descriptor.Status.SupportStatus != "unsupported" {
			return fmt.Errorf("provider %q installer kind is required", providerID)
		}
	default:
		return fmt.Errorf("provider %q installer kind %q is unsupported", providerID, descriptor.Status.Install.Kind)
	}
	if descriptor.Status.Install.Kind != "" && strings.TrimSpace(descriptor.Status.Install.DisplayCommand) == "" {
		return fmt.Errorf("provider %q installer display command is required", providerID)
	}
	if err := validateUpdateDescriptor(providerID, descriptor.Status); err != nil {
		return err
	}
	if err := validateAuthWatch(descriptor.Status.AuthWatch); err != nil {
		return fmt.Errorf("provider %q auth watch: %w", providerID, err)
	}
	switch descriptor.ComposerProfile.ModelCatalog {
	case "", ModelCatalogKindCodexCLI, ModelCatalogKindOpenCodeCLI, ModelCatalogKindTuttiCLI:
	default:
		return fmt.Errorf("provider %q model catalog kind %q is unsupported", providerID, descriptor.ComposerProfile.ModelCatalog)
	}
	switch descriptor.ComposerProfile.ConfiguredModelOverride {
	case "":
	case ConfiguredModelOverrideCodexCustomProvider:
		if descriptor.ComposerProfile.ModelCatalog != ModelCatalogKindCodexCLI {
			return fmt.Errorf("provider %q codex custom-provider override requires the Codex model catalog", providerID)
		}
	default:
		return fmt.Errorf("provider %q configured model override %q is unsupported", providerID, descriptor.ComposerProfile.ConfiguredModelOverride)
	}
	switch descriptor.ComposerProfile.CapabilityCatalog.Kind {
	case "", CapabilityCatalogKindCodexAppServer:
	default:
		return fmt.Errorf("provider %q capability catalog kind %q is unsupported", providerID, descriptor.ComposerProfile.CapabilityCatalog.Kind)
	}
	switch descriptor.ComposerProfile.Skills.Kind {
	case "":
		if descriptor.ComposerProfile.Skills.Invocation != "" {
			return fmt.Errorf("provider %q skill invocation requires a skill kind", providerID)
		}
		if strings.TrimSpace(descriptor.ComposerProfile.Skills.ConfigDirSuffix) != "" {
			return fmt.Errorf("provider %q skill config directory suffix requires a skill kind", providerID)
		}
	case SkillKindCodex, SkillKindClaudeCode, SkillKindCursor, SkillKindOpenCode:
		switch descriptor.ComposerProfile.Skills.Invocation {
		case SkillInvocationPromptItem, SkillInvocationTextTrigger:
		default:
			return fmt.Errorf("provider %q skill invocation %q is unsupported", providerID, descriptor.ComposerProfile.Skills.Invocation)
		}
		configDirSuffix := strings.TrimSpace(descriptor.ComposerProfile.Skills.ConfigDirSuffix)
		if descriptor.ComposerProfile.Skills.Kind == SkillKindOpenCode {
			if configDirSuffix == "" {
				return fmt.Errorf("provider %q OpenCode skills require a config directory suffix", providerID)
			}
		} else if configDirSuffix != "" {
			return fmt.Errorf("provider %q skill config directory suffix is only supported by OpenCode skills", providerID)
		}
	default:
		return fmt.Errorf("provider %q skill kind %q is unsupported", providerID, descriptor.ComposerProfile.Skills.Kind)
	}
	if descriptor.ComposerProfile.ReasoningEffort {
		switch descriptor.ComposerProfile.ReasoningEffortOptions {
		case ReasoningEffortOptionsStatic:
			if len(descriptor.ComposerProfile.ReasoningEffortValues) == 0 {
				return fmt.Errorf("provider %q static reasoning options require values", providerID)
			}
		case ReasoningEffortOptionsModelCatalog, ReasoningEffortOptionsStrictModelCatalog:
			if descriptor.ComposerProfile.ModelCatalog == "" {
				return fmt.Errorf("provider %q model-catalog reasoning options require a model catalog", providerID)
			}
			if len(descriptor.ComposerProfile.ReasoningEffortValues) != 0 {
				return fmt.Errorf("provider %q model-catalog reasoning options cannot declare static values", providerID)
			}
		default:
			return fmt.Errorf("provider %q reasoning option source %q is unsupported", providerID, descriptor.ComposerProfile.ReasoningEffortOptions)
		}
	} else if descriptor.ComposerProfile.ReasoningEffortOptions != "" {
		return fmt.Errorf("provider %q reasoning option source requires reasoning support", providerID)
	}
	if descriptor.ComposerProfile.Speed {
		if err := validateUniqueNonBlankStrings(descriptor.ComposerProfile.SpeedValues); err != nil {
			return fmt.Errorf("provider %q speed values: %w", providerID, err)
		}
		if len(descriptor.ComposerProfile.SpeedValues) == 0 {
			return fmt.Errorf("provider %q speed support requires values", providerID)
		}
		defaultSpeed := strings.TrimSpace(descriptor.ComposerProfile.DefaultSpeed)
		if !containsNormalized(descriptor.ComposerProfile.SpeedValues, defaultSpeed) {
			return fmt.Errorf("provider %q default speed %q is not declared", providerID, defaultSpeed)
		}
	} else if len(descriptor.ComposerProfile.SpeedValues) != 0 || strings.TrimSpace(descriptor.ComposerProfile.DefaultSpeed) != "" {
		return fmt.Errorf("provider %q speed values require speed support", providerID)
	}
	if err := validateUniqueNonBlankStrings(descriptor.ComposerProfile.Capabilities); err != nil {
		return fmt.Errorf("provider %q capabilities: %w", providerID, err)
	}
	for _, capability := range descriptor.ComposerProfile.Capabilities {
		if !IsKnownCapability(capability) {
			return fmt.Errorf("provider %q capability %q is unsupported", providerID, capability)
		}
	}
	switch descriptor.ComposerProfile.PlanDecisionStrategy {
	case PlanDecisionStrategyNone:
		if containsNormalized(descriptor.ComposerProfile.Capabilities, normalize(CapabilityPlanImplementation)) {
			return fmt.Errorf("provider %q plan implementation capability requires a plan decision strategy", providerID)
		}
	case PlanDecisionStrategyImplementPrompt:
		if !containsNormalized(descriptor.ComposerProfile.Capabilities, normalize(CapabilityPlanImplementation)) {
			return fmt.Errorf("provider %q implement-prompt strategy requires the plan implementation capability", providerID)
		}
	default:
		return fmt.Errorf("provider %q plan decision strategy %q is unsupported", providerID, descriptor.ComposerProfile.PlanDecisionStrategy)
	}
	switch descriptor.ComposerProfile.LiveModelDiscovery.Kind {
	case "", LiveModelDiscoveryKindClaudeSDK, LiveModelDiscoveryKindRuntimeSession:
	default:
		return fmt.Errorf("provider %q live model discovery kind %q is unsupported", providerID, descriptor.ComposerProfile.LiveModelDiscovery.Kind)
	}
	if descriptor.ComposerProfile.LiveModelDiscovery.Kind == "" &&
		(descriptor.ComposerProfile.LiveModelDiscovery.HiddenProbe || descriptor.ComposerProfile.LiveModelDiscovery.AccountScoped) {
		return fmt.Errorf("provider %q live model discovery behavior requires a discovery kind", providerID)
	}
	if descriptor.ComposerProfile.LiveModelDiscovery.Kind != "" && descriptor.ComposerProfile.ModelCatalog != "" {
		return fmt.Errorf("provider %q cannot declare both live model discovery and a model catalog", providerID)
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
	case TurnLifecycleProjectionExplicit:
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
	switch descriptor.ComposerProfile.ModelCapabilityRuleKind {
	case "", ModelCapabilityRuleKindCursorComposerImage:
	default:
		return fmt.Errorf("provider %q model capability rule kind %q is unsupported", providerID, descriptor.ComposerProfile.ModelCapabilityRuleKind)
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

func validateExternalImportDescriptor(descriptor ExternalImportDescriptor) error {
	if !descriptor.Enabled {
		if descriptor.RootEnvVar != "" || descriptor.DefaultRoot != "" || len(descriptor.ScanDirectories) > 0 || len(descriptor.SkipDirectoryPrefixes) > 0 || descriptor.ParserKind != "" || descriptor.UserTextCleanerKind != "" || descriptor.TitleCatalogKind != "" || descriptor.NoProjectHomeRelativeDir != "" {
			return fmt.Errorf("disabled descriptor must not declare import strategies")
		}
		return nil
	}
	if strings.TrimSpace(descriptor.DefaultRoot) == "" || len(descriptor.ScanDirectories) == 0 {
		return fmt.Errorf("enabled descriptor requires a default root and scan directories")
	}
	switch descriptor.ParserKind {
	case ExternalImportParserKindCodexJSONL, ExternalImportParserKindClaudeJSONL:
	default:
		return fmt.Errorf("parser kind %q is unsupported", descriptor.ParserKind)
	}
	switch descriptor.UserTextCleanerKind {
	case ExternalImportUserTextCleanerKindCodex, ExternalImportUserTextCleanerKindClaude:
	default:
		return fmt.Errorf("user text cleaner kind %q is unsupported", descriptor.UserTextCleanerKind)
	}
	switch descriptor.TitleCatalogKind {
	case "", ExternalImportTitleCatalogKindCodexSQLite:
	default:
		return fmt.Errorf("title catalog kind %q is unsupported", descriptor.TitleCatalogKind)
	}
	if err := validateUniqueNonBlankStrings(descriptor.ScanDirectories); err != nil {
		return fmt.Errorf("scan directories: %w", err)
	}
	if err := validateUniqueNonBlankStrings(descriptor.SkipDirectoryPrefixes); err != nil {
		return fmt.Errorf("skip directory prefixes: %w", err)
	}
	return nil
}

func validateStandardACPRuntime(descriptor StandardACPRuntimeDescriptor) error {
	switch descriptor.AdapterStrategy {
	case "", StandardACPAdapterStrategyGeneric, StandardACPAdapterStrategyCursor, StandardACPAdapterStrategyNexight, StandardACPAdapterStrategyOpenClaw, StandardACPAdapterStrategyOpenCode:
	default:
		return fmt.Errorf("adapter strategy %q is unsupported", descriptor.AdapterStrategy)
	}
	if strings.TrimSpace(descriptor.PlanModeDisabledRuntimeID) != "" && strings.TrimSpace(descriptor.PlanModeRuntimeID) == "" {
		return fmt.Errorf("plan-mode disabled runtime id requires a plan-mode runtime id")
	}
	modeIDs := make(map[string]struct{}, len(descriptor.PermissionModes))
	for index, mode := range descriptor.PermissionModes {
		inputID := strings.TrimSpace(mode.InputID)
		if _, ok := modeIDs[inputID]; ok {
			return fmt.Errorf("permission mode input %q is duplicated", inputID)
		}
		modeIDs[inputID] = struct{}{}
		if strings.TrimSpace(mode.RuntimeID) == "" {
			return fmt.Errorf("permission mode %d runtime id is empty", index)
		}
	}
	if descriptor.ProjectCurrentMode && strings.TrimSpace(descriptor.PlanModeRuntimeID) == "" {
		return fmt.Errorf("current-mode projection requires a plan mode runtime id")
	}
	for _, inputID := range descriptor.AutoApprovePermissionModeInputIDs {
		if _, ok := modeIDs[strings.TrimSpace(inputID)]; !ok {
			return fmt.Errorf("auto-approve permission mode %q is not declared", inputID)
		}
	}
	environment := descriptor.SettingsEnvironment
	variable := strings.TrimSpace(environment.Variable)
	if variable == "" && len(environment.JSONFields) == 0 {
		return nil
	}
	if variable == "" {
		return fmt.Errorf("settings environment variable is required")
	}
	if len(environment.JSONFields) == 0 {
		return fmt.Errorf("settings environment JSON fields are required")
	}
	jsonKeys := make(map[string]struct{}, len(environment.JSONFields))
	settings := make(map[RuntimeSettingField]struct{}, len(environment.JSONFields))
	for index, field := range environment.JSONFields {
		switch field.Setting {
		case RuntimeSettingFieldModel:
		default:
			return fmt.Errorf("settings environment field %d setting %q is unsupported", index, field.Setting)
		}
		if _, ok := settings[field.Setting]; ok {
			return fmt.Errorf("settings environment setting %q is duplicated", field.Setting)
		}
		settings[field.Setting] = struct{}{}
		jsonKey := strings.TrimSpace(field.JSONKey)
		if jsonKey == "" {
			return fmt.Errorf("settings environment field %d JSON key is empty", index)
		}
		if _, ok := jsonKeys[jsonKey]; ok {
			return fmt.Errorf("settings environment JSON key %q is duplicated", jsonKey)
		}
		jsonKeys[jsonKey] = struct{}{}
	}
	return nil
}

// KnownCapabilities returns the ordered canonical capability vocabulary used
// by provider descriptors, runtime projection, OpenAPI validation, and TS generation.
func KnownCapabilities() []string {
	return canonical.KnownCapabilities()
}

func IsKnownCapability(value string) bool {
	return canonical.IsKnownCapability(value)
}

func validateAuthWatch(descriptor AuthWatchDescriptor) error {
	switch descriptor.ContentFingerprint {
	case "", AuthWatchContentFingerprintFullFile, AuthWatchContentFingerprintClaudeState:
	default:
		return fmt.Errorf("content fingerprint %q is unsupported", descriptor.ContentFingerprint)
	}
	if descriptor.ContentFingerprint != "" && len(descriptor.Sources) == 0 {
		return fmt.Errorf("content fingerprint requires sources")
	}
	for index, source := range descriptor.Sources {
		if err := validateUniqueNonBlankStrings(source.PathEnvVars); err != nil {
			return fmt.Errorf("source %d path env vars: %w", index, err)
		}
		for candidateIndex, candidate := range source.RootCandidates {
			if strings.TrimSpace(candidate.EnvVar) == "" {
				return fmt.Errorf("source %d root candidate %d env var is empty", index, candidateIndex)
			}
		}
		hasRoot := len(source.RootCandidates) > 0 || strings.TrimSpace(source.DefaultRoot) != ""
		if hasRoot {
			if err := validateUniqueNonBlankStrings(source.Paths); err != nil {
				return fmt.Errorf("source %d paths: %w", index, err)
			}
			if len(source.Paths) == 0 {
				return fmt.Errorf("source %d rooted paths are required", index)
			}
		} else if len(source.Paths) > 0 {
			return fmt.Errorf("source %d paths require a root", index)
		}
		if len(source.PathEnvVars) == 0 && !hasRoot {
			return fmt.Errorf("source %d has no path source", index)
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
