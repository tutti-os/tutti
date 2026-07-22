package providerregistry

import (
	"slices"
	"testing"

	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestMigratedProviderIdentityAndPlanStrategyMatchCanonicalContract(t *testing.T) {
	for _, descriptor := range Migrated() {
		identity, found := canonical.FindProviderIdentity(descriptor.Identity.ID)
		if !found {
			t.Fatalf("provider %q missing canonical identity", descriptor.Identity.ID)
		}
		if descriptor.Identity.ID != identity.ID || descriptor.Identity.DisplayName != identity.DisplayName ||
			descriptor.Identity.IconKey != identity.IconKey || descriptor.Identity.LocaleKey != identity.LocaleKey ||
			!slices.Equal(descriptor.Identity.Aliases, identity.Aliases) {
			t.Fatalf("provider %q identity drifted from canonical: %#v != %#v", descriptor.Identity.ID, descriptor.Identity, identity)
		}
		strategy, found := canonical.ProviderPlanDecisionStrategy(descriptor.Identity.ID)
		if !found || descriptor.ComposerProfile.PlanDecisionStrategy != strategy {
			t.Fatalf("provider %q plan strategy = %q; canonical = %q, %v", descriptor.Identity.ID, descriptor.ComposerProfile.PlanDecisionStrategy, strategy, found)
		}
	}
}

func TestMigratedProviderUpdateSupportMatrixIsDescriptorDriven(t *testing.T) {
	want := map[string]UpdateDescriptor{
		CodexProviderID:      {Capability: UpdateCapabilitySupported, Source: UpdateSourceNPM, Strategy: UpdateStrategyManagedNPM, PackageName: "@openai/codex", BinaryName: "codex", IncludeOptional: true},
		TuttiAgentProviderID: {Capability: UpdateCapabilitySupported, Source: UpdateSourceNPM, Strategy: UpdateStrategyManagedNPM, PackageName: "@tutti-os/tutti-agent", BinaryName: "tutti-agent", IncludeOptional: true},
		ClaudeCodeProviderID: {Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonOfficialScript},
		CursorProviderID:     {Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonOfficialScript},
		OpenCodeProviderID:   {Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonOfficialScript},
		OpenClawProviderID:   {Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonUnmanagedSource},
		NexightProviderID:    {Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonProvider},
	}
	for provider, expected := range want {
		descriptor, ok := Find(provider)
		if !ok {
			t.Fatalf("Find(%q) = false", provider)
		}
		if descriptor.Status.Update != expected {
			t.Fatalf("provider %q update = %#v, want %#v", provider, descriptor.Status.Update, expected)
		}
	}
}

func TestMigratedTuttiAgentDescriptorRequiresRefreshCapableVersion(t *testing.T) {
	descriptor, ok := Find(TuttiAgentProviderID)
	if !ok {
		t.Fatal("Find(tutti-agent) ok = false")
	}
	if descriptor.Status.MinVersion != TuttiAgentMinVersion {
		t.Fatalf("Status.MinVersion = %q, want %q", descriptor.Status.MinVersion, TuttiAgentMinVersion)
	}
	if descriptor.Status.Install.PackageName != "@tutti-os/tutti-agent" ||
		descriptor.Status.Install.BinaryName != "tutti-agent" ||
		descriptor.Status.Install.RecommendedVersion != TuttiAgentRecommendedVersion ||
		!descriptor.Status.Install.IncludeOptional {
		t.Fatalf("Status.Install = %#v", descriptor.Status.Install)
	}
}

func TestValidateRejectsInvalidMinimumVersionFloor(t *testing.T) {
	for _, version := range []string{"latest", "1.0.0-beta.1", "1.0.0+build.1"} {
		t.Run("invalid floor "+version, func(t *testing.T) {
			descriptor := tuttiAgentDescriptor()
			descriptor.Status.MinVersion = version
			if err := Validate(descriptor); err == nil {
				t.Fatal("Validate() error = nil")
			}
		})
	}
	t.Run("missing repair installer", func(t *testing.T) {
		descriptor := tuttiAgentDescriptor()
		descriptor.Status.Install = InstallerDescriptor{}
		if err := Validate(descriptor); err == nil {
			t.Fatal("Validate() error = nil")
		}
	})
	t.Run("missing recommended version", func(t *testing.T) {
		descriptor := tuttiAgentDescriptor()
		descriptor.Status.Install.RecommendedVersion = ""
		if err := Validate(descriptor); err == nil {
			t.Fatal("Validate() error = nil")
		}
	})
}

func TestValidateRejectsUnsafeProviderUpdateDeclarations(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*UpdateDescriptor)
	}{
		{name: "missing capability", mutate: func(update *UpdateDescriptor) { update.Capability = "" }},
		{name: "unsupported source", mutate: func(update *UpdateDescriptor) { update.Source = "official_script" }},
		{name: "missing package", mutate: func(update *UpdateDescriptor) { update.PackageName = "" }},
		{name: "unsupported with execution", mutate: func(update *UpdateDescriptor) {
			*update = UpdateDescriptor{Capability: UpdateCapabilityUnsupported, Source: UpdateSourceNPM, UnsupportedReason: UpdateUnsupportedReasonProvider}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			descriptor := codexDescriptor()
			test.mutate(&descriptor.Status.Update)
			if err := Validate(descriptor); err == nil {
				t.Fatal("Validate() error = nil")
			}
		})
	}
	t.Run("official script cannot claim managed update", func(t *testing.T) {
		descriptor := claudeCodeDescriptor()
		descriptor.Status.Update = UpdateDescriptor{
			Capability: UpdateCapabilitySupported,
			Source:     UpdateSourceNPM, Strategy: UpdateStrategyManagedNPM,
			PackageName: "@anthropic-ai/claude-code", BinaryName: "claude",
		}
		if err := Validate(descriptor); err == nil {
			t.Fatal("Validate() error = nil")
		}
	})
}

func TestMigratedCodexDescriptorIsComplete(t *testing.T) {
	if err := ValidateMigrated(); err != nil {
		t.Fatalf("ValidateMigrated() error = %v", err)
	}
	descriptor, ok := Find(" CODEX ")
	if !ok {
		t.Fatal("Find(codex) ok = false")
	}
	if err := Validate(descriptor); err != nil {
		t.Fatalf("Validate(codex) error = %v", err)
	}
	if descriptor.Runtime.Kind != RuntimeKindCodexAppServer {
		t.Fatalf("Runtime.Kind = %q", descriptor.Runtime.Kind)
	}
	if descriptor.Runtime.Name != "codex-app-server" {
		t.Fatalf("Runtime.Name = %q", descriptor.Runtime.Name)
	}
	if descriptor.Runtime.ClientInfoName == "" || descriptor.Runtime.AuthRequiredMessage == "" {
		t.Fatalf("Runtime identity/auth = %#v", descriptor.Runtime)
	}
	if descriptor.Runtime.Endpoint.ConfigKind != EndpointConfigKindCodexCLI {
		t.Fatalf("Runtime.Endpoint.ConfigKind = %q", descriptor.Runtime.Endpoint.ConfigKind)
	}
	if descriptor.Events.TurnLifecycleProjection != TurnLifecycleProjectionExplicit {
		t.Fatalf("Events.TurnLifecycleProjection = %q", descriptor.Events.TurnLifecycleProjection)
	}
	if descriptor.Target.ID != CodexTargetID {
		t.Fatalf("Target.ID = %q", descriptor.Target.ID)
	}
	if descriptor.ComposerProfile.ConfigOptionIDs.Reasoning != "reasoning_effort" {
		t.Fatalf("Reasoning config option = %q", descriptor.ComposerProfile.ConfigOptionIDs.Reasoning)
	}
	if descriptor.ComposerProfile.ConfigOptionIDs.Speed != "service_tier" {
		t.Fatalf("Speed config option = %q", descriptor.ComposerProfile.ConfigOptionIDs.Speed)
	}
	if !slices.Equal(descriptor.ComposerProfile.SpeedValues, []string{"standard", "fast"}) || descriptor.ComposerProfile.DefaultSpeed != "standard" {
		t.Fatalf("Speed profile = %#v, default %q", descriptor.ComposerProfile.SpeedValues, descriptor.ComposerProfile.DefaultSpeed)
	}
	if descriptor.Status.MinVersion != CodexMinVersion {
		t.Fatalf("Status.MinVersion = %q", descriptor.Status.MinVersion)
	}
	if descriptor.Status.Install.PackageName != "@openai/codex" ||
		descriptor.Status.Install.BinaryName != "codex" ||
		!descriptor.Status.Install.IncludeOptional {
		t.Fatalf("Status.Install = %#v", descriptor.Status.Install)
	}
	if descriptor.ComposerProfile.CapabilityCatalog.Kind != CapabilityCatalogKindCodexAppServer {
		t.Fatalf("CapabilityCatalog = %#v", descriptor.ComposerProfile.CapabilityCatalog)
	}
	if !slices.Contains(descriptor.ComposerProfile.Capabilities, CapabilityGoalPause) {
		t.Fatalf("Composer capabilities missing Codex goal pause: %#v", descriptor.ComposerProfile.Capabilities)
	}
	effects := descriptor.ComposerProfile.SlashCommandPolicy.CommandEffects
	if len(effects) != 7 {
		t.Fatalf("SlashCommandPolicy = %#v", descriptor.ComposerProfile.SlashCommandPolicy)
	}
	goalEffectFound := false
	for _, effect := range effects {
		if effect.Command == "goal" && effect.Effect == SlashCommandEffectActivateGoalMode {
			goalEffectFound = true
			break
		}
	}
	if !goalEffectFound {
		t.Fatalf("SlashCommandPolicy goal effect missing: %#v", effects)
	}
}

func TestMigratedProviderSetIsComplete(t *testing.T) {
	want := map[string]bool{
		ClaudeCodeProviderID: true,
		CodexProviderID:      true,
		CursorProviderID:     true,
		NexightProviderID:    true,
		OpenClawProviderID:   true,
		OpenCodeProviderID:   true,
		TuttiAgentProviderID: true,
	}
	for _, descriptor := range Migrated() {
		if !want[descriptor.Identity.ID] {
			t.Fatalf("unexpected migrated provider %q", descriptor.Identity.ID)
		}
		delete(want, descriptor.Identity.ID)
	}
	if len(want) != 0 {
		t.Fatalf("providers missing from migrated registry: %#v", want)
	}
}

func TestExternalizedProvidersAreNotBuiltInTargets(t *testing.T) {
	for _, provider := range []string{"hermes", "kimi-code"} {
		if _, ok := Find(provider); ok {
			t.Fatalf("Find(%q) = true, want signed Agent Extension ownership", provider)
		}
		if normalized, ok := NormalizeOpenProviderID("acp:" + provider); !ok || normalized != "acp:"+provider {
			t.Fatalf("NormalizeOpenProviderID(acp:%s) = %q, %v", provider, normalized, ok)
		}
	}
}

func TestNormalizeOpenProviderID(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		" CODEX ":         CodexProviderID,
		"acp:gemini":      "acp:gemini",
		"vendor.agent-v2": "vendor.agent-v2",
	}
	for input, want := range tests {
		got, ok := NormalizeOpenProviderID(input)
		if !ok || got != want {
			t.Fatalf("NormalizeOpenProviderID(%q) = %q, %v; want %q, true", input, got, ok, want)
		}
	}
	for _, input := range []string{"", "ACP:gemini", "acp/gemini", "-gemini"} {
		if got, ok := NormalizeOpenProviderID(input); ok {
			t.Fatalf("NormalizeOpenProviderID(%q) = %q, true; want rejected", input, got)
		}
	}
}

func TestMigratedProviderSidecarPoliciesAreDescriptorOwned(t *testing.T) {
	want := map[string]SidecarDescriptor{
		CodexProviderID:      {ExecutionEnvironment: SidecarExecutionEnvironmentCodexSandbox},
		ClaudeCodeProviderID: {MentionRouting: SidecarMentionRoutingClaudeNamespaced, ExecutionEnvironment: SidecarExecutionEnvironmentClaudeIPC},
		CursorProviderID:     {ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
		TuttiAgentProviderID: {ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
		OpenCodeProviderID:   {ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
		NexightProviderID:    {ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC, SkillRoot: ".nexight/skills"},
		OpenClawProviderID:   {ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC, SkillRoot: ".openclaw/skills"},
	}
	for _, descriptor := range Migrated() {
		if descriptor.Sidecar != want[descriptor.Identity.ID] {
			t.Fatalf("provider %q sidecar = %#v, want %#v", descriptor.Identity.ID, descriptor.Sidecar, want[descriptor.Identity.ID])
		}
		delete(want, descriptor.Identity.ID)
	}
	if len(want) != 0 {
		t.Fatalf("provider sidecar policies missing: %#v", want)
	}
}

func TestMigratedProviderDesktopIntegrationIsDescriptorOwned(t *testing.T) {
	want := map[string]DesktopIntegrationDescriptor{
		CodexProviderID:      {Managed: true, ManagedOrder: 2, StatusProbePriority: 1, UsageProbeKind: DesktopUsageProbeCodex, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 1},
		ClaudeCodeProviderID: {Managed: true, ManagedOrder: 1, StatusProbePriority: 2, UsageProbeKind: DesktopUsageProbeClaudeCode, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 2},
		CursorProviderID:     {Managed: true, ManagedOrder: 3, StatusProbePriority: 3, RuntimeProbeFallback: DesktopRuntimeProbeFallbackDirect, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 3},
		TuttiAgentProviderID: {Managed: true, ManagedOrder: 4, StatusProbePriority: 4, VisibilityGate: DesktopVisibilityGateTuttiAgent, InstallBootstrap: true, RefreshOnAccountChange: true},
		OpenCodeProviderID:   {Managed: true, ManagedOrder: 5, StatusProbePriority: 5, DefaultProviderEligible: true, DefaultProviderPriority: 4},
		NexightProviderID:    {},
		OpenClawProviderID:   {Managed: true, ManagedOrder: 7, StatusProbePriority: 7, UnavailableDockOrderOffset: 200},
	}
	for _, descriptor := range Migrated() {
		if descriptor.Desktop != want[descriptor.Identity.ID] {
			t.Fatalf("provider %q desktop = %#v, want %#v", descriptor.Identity.ID, descriptor.Desktop, want[descriptor.Identity.ID])
		}
		delete(want, descriptor.Identity.ID)
	}
	if len(want) != 0 {
		t.Fatalf("provider desktop integrations missing: %#v", want)
	}
}

func TestMigratedOpenCodeDescriptorIsComplete(t *testing.T) {
	if err := ValidateMigrated(); err != nil {
		t.Fatalf("ValidateMigrated() error = %v", err)
	}
	descriptor, ok := Find(" OPEN-CODE ")
	if !ok {
		t.Fatal("Find(open-code) ok = false")
	}
	if err := Validate(descriptor); err != nil {
		t.Fatalf("Validate(opencode) error = %v", err)
	}
	if descriptor.Runtime.Kind != RuntimeKindStandardACP || descriptor.Runtime.Name != "opencode-acp" {
		t.Fatalf("Runtime = %#v", descriptor.Runtime)
	}
	if descriptor.Status.Kind != StatusKindOpenCodeCLI || descriptor.Status.Install.Kind != InstallerKindOfficialScript {
		t.Fatalf("Status = %#v", descriptor.Status)
	}
	if descriptor.ComposerProfile.ModelCatalog != ModelCatalogKindOpenCodeCLI ||
		descriptor.ComposerProfile.ConfigOptionIDs.Model != "model" ||
		descriptor.ComposerProfile.ConfigOptionIDs.Reasoning != "effort" {
		t.Fatalf("ComposerProfile = %#v", descriptor.ComposerProfile)
	}
	if !slices.Equal(descriptor.ComposerProfile.SlashCommandPolicy.FallbackCommands, []string{"compact", "goal", "review"}) ||
		len(descriptor.ComposerProfile.SlashCommandPolicy.CommandEffects) != 4 {
		t.Fatalf("SlashCommandPolicy = %#v", descriptor.ComposerProfile.SlashCommandPolicy)
	}
	if descriptor.Target.ID != OpenCodeTargetID || descriptor.Events.TurnLifecycleProjection != TurnLifecycleProjectionExplicit {
		t.Fatalf("target/events = %#v %#v", descriptor.Target, descriptor.Events)
	}
}

func TestMigratedClaudeCodeDescriptorIsComplete(t *testing.T) {
	descriptor, ok := Find("Claude Code")
	if !ok {
		t.Fatal("Find(Claude Code) ok = false")
	}
	if err := Validate(descriptor); err != nil {
		t.Fatalf("Validate(claude-code) error = %v", err)
	}
	if descriptor.Runtime.Kind != RuntimeKindClaudeSDK ||
		descriptor.Status.Kind != StatusKindClaudeCLI ||
		descriptor.ComposerProfile.LiveModelDiscovery.Kind != LiveModelDiscoveryKindClaudeSDK ||
		!descriptor.ComposerProfile.LiveModelDiscovery.HiddenProbe ||
		!descriptor.ComposerProfile.LiveModelDiscovery.AccountScoped {
		t.Fatalf("implementation kinds = %#v", descriptor)
	}
	if descriptor.Target.ID != ClaudeCodeTargetID ||
		descriptor.Status.Install.Kind != InstallerKindOfficialScript ||
		descriptor.Status.AuthStatusCommandTimeoutSeconds != 600 {
		t.Fatalf("target/status = %#v / %#v", descriptor.Target, descriptor.Status)
	}
	if !descriptor.ComposerProfile.Behavior.ModelOptionsAuthoritative ||
		!descriptor.ComposerProfile.Behavior.RefreshModelOptionsAfterSettings ||
		!descriptor.ComposerProfile.Behavior.PrewarmDraftSession ||
		!descriptor.ComposerProfile.Behavior.PlanModeExclusiveWithPermissionMode {
		t.Fatalf("composer behavior = %#v", descriptor.ComposerProfile.Behavior)
	}
}

func TestMigratedReturnsClones(t *testing.T) {
	first := Migrated()
	first[0].Runtime.Command[0] = "mutated"
	first[0].Runtime.Endpoint.BaseURLEnvVars[0] = "mutated"
	first[0].Status.AuthWatch.Sources[0].Paths[0] = "mutated"
	first[0].ComposerProfile.Capabilities[0] = "mutated"
	first[0].ComposerProfile.SlashCommandPolicy.FallbackCommands[0] = "mutated"
	first[0].ComposerProfile.SlashCommandPolicy.CommandEffects[0].Command = "mutated"
	first[1].Status.AuthWatch.Sources[0].Paths[0] = "mutated"

	second := Migrated()
	if second[0].Runtime.Command[0] != "codex" {
		t.Fatalf("Runtime.Command leaked mutation: %#v", second[0].Runtime.Command)
	}
	if second[0].Runtime.Endpoint.BaseURLEnvVars[0] != "OPENAI_BASE_URL" {
		t.Fatalf("Runtime.Endpoint.BaseURLEnvVars leaked mutation: %#v", second[0].Runtime.Endpoint.BaseURLEnvVars)
	}
	if second[0].Status.AuthWatch.Sources[0].Paths[0] != "auth.json" {
		t.Fatalf("Status.AuthWatch.Sources leaked mutation: %#v", second[0].Status.AuthWatch.Sources)
	}
	if second[0].ComposerProfile.Capabilities[0] != "imageInput" {
		t.Fatalf("Capabilities leaked mutation: %#v", second[0].ComposerProfile.Capabilities)
	}
	if second[0].ComposerProfile.SlashCommandPolicy.FallbackCommands[0] != "compact" ||
		second[0].ComposerProfile.SlashCommandPolicy.CommandEffects[0].Command != "init" {
		t.Fatalf("SlashCommandPolicy leaked mutation: %#v", second[0].ComposerProfile.SlashCommandPolicy)
	}
	if second[1].Status.AuthWatch.Sources[0].Paths[0] != "settings.json" {
		t.Fatalf("Claude Status.AuthWatch.Sources leaked mutation: %#v", second[1].Status.AuthWatch.Sources)
	}
}

func TestMigratedReturnsOpenCodeNestedClones(t *testing.T) {
	first, ok := Find(OpenCodeProviderID)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	first.Runtime.StandardACP.PlanModeDisabledRuntimeID = "mutated"
	first.Runtime.StandardACP.SettingsEnvironment.JSONFields[0].JSONKey = "mutated"
	first.Status.AuthWatch.Sources[0].PathEnvVars[0] = "MUTATED"
	first.Status.AuthWatch.Sources[1].RootCandidates[0].EnvVar = "MUTATED"
	first.Status.AuthWatch.Sources[1].Paths[0] = "mutated"

	second, ok := Find(OpenCodeProviderID)
	if !ok {
		t.Fatal("opencode descriptor missing after mutation")
	}
	if second.Runtime.StandardACP.PlanModeDisabledRuntimeID != "build" ||
		second.Runtime.StandardACP.SettingsEnvironment.JSONFields[0].JSONKey != "model" {
		t.Fatalf("Runtime.StandardACP leaked mutation: %#v", second.Runtime.StandardACP)
	}
	if second.Status.AuthWatch.Sources[0].PathEnvVars[0] != "OPENCODE_CONFIG" ||
		second.Status.AuthWatch.Sources[1].RootCandidates[0].EnvVar != "OPENCODE_CONFIG_DIR" ||
		second.Status.AuthWatch.Sources[1].Paths[0] != "opencode.json" {
		t.Fatalf("Status.AuthWatch leaked mutation: %#v", second.Status.AuthWatch)
	}
}

func TestResolveProviderProjectionsDoNotExposeDescriptors(t *testing.T) {
	providerID, ok := ResolveProviderID(" CODEX ")
	if !ok || providerID != CodexProviderID {
		t.Fatalf("ResolveProviderID(CODEX) = %q, %v", providerID, ok)
	}
	eventProvider, ok := ResolveEventProvider(" CODEX ")
	if !ok || eventProvider.ProviderID != CodexProviderID ||
		eventProvider.TurnLifecycleProjection != TurnLifecycleProjectionExplicit {
		t.Fatalf("ResolveEventProvider(CODEX) = %#v, %v", eventProvider, ok)
	}
	if _, ok := ResolveProviderID("unknown"); ok {
		t.Fatal("ResolveProviderID(unknown) ok = true")
	}
	if _, ok := ResolveEventProvider("unknown"); ok {
		t.Fatal("ResolveEventProvider(unknown) ok = true")
	}
	providerID, ok = ResolveProviderID("opencode-ai")
	if !ok || providerID != OpenCodeProviderID {
		t.Fatalf("ResolveProviderID(opencode-ai) = %q, %v", providerID, ok)
	}
}

func TestResolveModelPlanProtocolOnlyForPreparedProviders(t *testing.T) {
	tests := []struct {
		provider string
		want     ModelPlanProtocol
	}{
		{provider: CodexProviderID, want: ModelPlanProtocolOpenAI},
		{provider: ClaudeCodeProviderID, want: ModelPlanProtocolAnthropic},
		{provider: TuttiAgentProviderID, want: ModelPlanProtocolOpenAI},
		{provider: OpenCodeProviderID, want: ModelPlanProtocolOpenAI},
	}
	for _, test := range tests {
		protocol, ok := ResolveModelPlanProtocol(test.provider)
		if !ok || protocol != test.want {
			t.Fatalf("ResolveModelPlanProtocol(%q) = %q, %v; want %q, true", test.provider, protocol, ok, test.want)
		}
	}
	for _, provider := range []string{CursorProviderID, "unknown"} {
		if protocol, ok := ResolveModelPlanProtocol(provider); ok {
			t.Fatalf("ResolveModelPlanProtocol(%q) = %q, true; want unresolved", provider, protocol)
		}
	}
	addressing, ok := ResolveModelPlanModelAddressing(OpenCodeProviderID)
	if !ok || addressing != ModelPlanModelAddressingProviderPrefixed {
		t.Fatalf("ResolveModelPlanModelAddressing(opencode) = %q, %v; want provider_prefixed", addressing, ok)
	}
}

func TestValidateRejectsUnsupportedDescriptorStrategies(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ProviderDescriptor)
	}{
		{name: "runtime kind", mutate: func(value *ProviderDescriptor) { value.Runtime.Kind = "poison" }},
		{name: "noncanonical provider id", mutate: func(value *ProviderDescriptor) { value.Identity.ID = " CODEX " }},
		{name: "blank identity alias", mutate: func(value *ProviderDescriptor) { value.Identity.Aliases = []string{" "} }},
		{name: "duplicate identity alias", mutate: func(value *ProviderDescriptor) { value.Identity.Aliases = []string{"alias", " ALIAS "} }},
		{name: "identity alias repeats id", mutate: func(value *ProviderDescriptor) { value.Identity.Aliases = []string{"CODEX"} }},
		{name: "runtime command", mutate: func(value *ProviderDescriptor) { value.Runtime.Command[1] = " " }},
		{name: "runtime client info", mutate: func(value *ProviderDescriptor) { value.Runtime.ClientInfoName = " " }},
		{name: "runtime auth message", mutate: func(value *ProviderDescriptor) { value.Runtime.AuthRequiredMessage = " " }},
		{name: "model plan protocol", mutate: func(value *ProviderDescriptor) { value.Runtime.Endpoint.ModelPlanProtocol = "poison" }},
		{name: "model plan capability missing", mutate: func(value *ProviderDescriptor) {
			value.ComposerProfile.Capabilities = slices.DeleteFunc(value.ComposerProfile.Capabilities, func(capability string) bool {
				return capability == CapabilityModelPlanBinding
			})
		}},
		{name: "status kind", mutate: func(value *ProviderDescriptor) { value.Status.Kind = "poison" }},
		{name: "status auth command", mutate: func(value *ProviderDescriptor) { value.Status.AuthStatusCommand[0] = " " }},
		{name: "status auth marker", mutate: func(value *ProviderDescriptor) { value.Status.AuthMarkerPaths[0] = " " }},
		{name: "status login args", mutate: func(value *ProviderDescriptor) { value.Status.LoginArgs[0] = " " }},
		{name: "status npm package", mutate: func(value *ProviderDescriptor) { value.Status.NPMRegistryPackage = " " }},
		{name: "installer kind", mutate: func(value *ProviderDescriptor) { value.Status.Install.Kind = "poison" }},
		{name: "installer package mismatch", mutate: func(value *ProviderDescriptor) { value.Status.Install.PackageName = "poison" }},
		{name: "model catalog kind", mutate: func(value *ProviderDescriptor) { value.ComposerProfile.ModelCatalog = "poison" }},
		{name: "model catalog with static reasoning values", mutate: func(value *ProviderDescriptor) {
			value.ComposerProfile.ReasoningEffortValues = []string{"high"}
		}},
		{name: "config directory suffix on non-OpenCode skills", mutate: func(value *ProviderDescriptor) {
			value.ComposerProfile.Skills.ConfigDirSuffix = "codex"
		}},
		{name: "capability catalog kind", mutate: func(value *ProviderDescriptor) { value.ComposerProfile.CapabilityCatalog.Kind = "poison" }},
		{name: "target launch ref type", mutate: func(value *ProviderDescriptor) { value.Target.LaunchRefType = "poison" }},
		{name: "blank event alias", mutate: func(value *ProviderDescriptor) { value.Events.Aliases = []string{" "} }},
		{name: "duplicate event alias", mutate: func(value *ProviderDescriptor) { value.Events.Aliases = []string{"alias", " ALIAS "} }},
		{name: "event alias repeats id", mutate: func(value *ProviderDescriptor) { value.Events.Aliases = []string{"CODEX"} }},
		{name: "slash command effect", mutate: func(value *ProviderDescriptor) {
			value.ComposerProfile.SlashCommandPolicy.CommandEffects[0].Effect = "poison"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			descriptor := codexDescriptor()
			test.mutate(&descriptor)
			if err := Validate(descriptor); err == nil {
				t.Fatalf("Validate() error = nil for %#v", descriptor)
			}
		})
	}
}

func TestValidateRejectsInvalidSlashCommandPolicy(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*SlashCommandPolicyDescriptor)
	}{
		{name: "empty fallback", mutate: func(value *SlashCommandPolicyDescriptor) { value.FallbackCommands[0] = " " }},
		{name: "duplicate fallback", mutate: func(value *SlashCommandPolicyDescriptor) { value.FallbackCommands[1] = "COMPACT" }},
		{name: "empty effect command", mutate: func(value *SlashCommandPolicyDescriptor) { value.CommandEffects[0].Command = " " }},
		{name: "duplicate effect command", mutate: func(value *SlashCommandPolicyDescriptor) { value.CommandEffects[1].Command = "INIT" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			descriptor := codexDescriptor()
			test.mutate(&descriptor.ComposerProfile.SlashCommandPolicy)
			if err := Validate(descriptor); err == nil {
				t.Fatal("Validate() error = nil")
			}
		})
	}
}

func TestValidateRejectsInvalidStandardACPDescriptorStrategies(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ProviderDescriptor)
	}{
		{name: "blank permission runtime mode", mutate: func(value *ProviderDescriptor) {
			value.Runtime.StandardACP.PermissionModes = append(
				value.Runtime.StandardACP.PermissionModes,
				RuntimePermissionModeDescriptor{InputID: "ask", RuntimeID: " "},
			)
		}},
		{name: "plan disabled mode without plan mode", mutate: func(value *ProviderDescriptor) {
			value.Runtime.StandardACP.PlanModeRuntimeID = ""
		}},
		{name: "duplicate permission input mode", mutate: func(value *ProviderDescriptor) {
			value.Runtime.StandardACP.PermissionModes = []RuntimePermissionModeDescriptor{
				{InputID: "ask", RuntimeID: "ask"},
				{InputID: "ask", RuntimeID: "prompt"},
			}
		}},
		{name: "missing settings environment variable", mutate: func(value *ProviderDescriptor) {
			value.Runtime.StandardACP.SettingsEnvironment.Variable = ""
		}},
		{name: "unsupported settings field", mutate: func(value *ProviderDescriptor) {
			value.Runtime.StandardACP.SettingsEnvironment.JSONFields[0].Setting = "poison"
		}},
		{name: "blank capability", mutate: func(value *ProviderDescriptor) {
			value.ComposerProfile.Capabilities[0] = " "
		}},
		{name: "unknown capability", mutate: func(value *ProviderDescriptor) {
			value.ComposerProfile.Capabilities[0] = "imageInputTypo"
		}},
		{name: "missing official installer URL", mutate: func(value *ProviderDescriptor) {
			value.Status.Install.ScriptURL = ""
		}},
		{name: "auth watch paths without root", mutate: func(value *ProviderDescriptor) {
			value.Status.AuthWatch.Sources[1].RootCandidates = nil
			value.Status.AuthWatch.Sources[1].DefaultRoot = ""
		}},
		{name: "unsupported auth fingerprint", mutate: func(value *ProviderDescriptor) {
			value.Status.AuthWatch.ContentFingerprint = "poison"
		}},
		{name: "missing OpenCode skill config directory suffix", mutate: func(value *ProviderDescriptor) {
			value.ComposerProfile.Skills.ConfigDirSuffix = ""
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			descriptor := openCodeDescriptor()
			test.mutate(&descriptor)
			if err := Validate(descriptor); err == nil {
				t.Fatalf("Validate() error = nil for %#v", descriptor)
			}
		})
	}
}
