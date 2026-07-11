package providerregistry

import "testing"

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
		descriptor.ComposerProfile.LiveModelDiscovery.Kind != LiveModelDiscoveryKindClaudeSDK {
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
	first[0].Status.AuthWatch.Paths[0] = "mutated"
	first[0].ComposerProfile.Capabilities[0] = "mutated"
	first[0].ComposerProfile.SlashCommandPolicy.FallbackCommands[0] = "mutated"
	first[0].ComposerProfile.SlashCommandPolicy.CommandEffects[0].Command = "mutated"
	first[1].Status.AuthWatch.HomePaths[0] = "mutated"

	second := Migrated()
	if second[0].Runtime.Command[0] != "codex" {
		t.Fatalf("Runtime.Command leaked mutation: %#v", second[0].Runtime.Command)
	}
	if second[0].Runtime.Endpoint.BaseURLEnvVars[0] != "OPENAI_BASE_URL" {
		t.Fatalf("Runtime.Endpoint.BaseURLEnvVars leaked mutation: %#v", second[0].Runtime.Endpoint.BaseURLEnvVars)
	}
	if second[0].Status.AuthWatch.Paths[0] != "auth.json" {
		t.Fatalf("Status.AuthWatch.Paths leaked mutation: %#v", second[0].Status.AuthWatch.Paths)
	}
	if second[0].ComposerProfile.Capabilities[0] != "imageInput" {
		t.Fatalf("Capabilities leaked mutation: %#v", second[0].ComposerProfile.Capabilities)
	}
	if second[0].ComposerProfile.SlashCommandPolicy.FallbackCommands[0] != "compact" ||
		second[0].ComposerProfile.SlashCommandPolicy.CommandEffects[0].Command != "init" {
		t.Fatalf("SlashCommandPolicy leaked mutation: %#v", second[0].ComposerProfile.SlashCommandPolicy)
	}
	if second[1].Status.AuthWatch.HomePaths[0] != ".claude.json" {
		t.Fatalf("Status.AuthWatch.HomePaths leaked mutation: %#v", second[1].Status.AuthWatch.HomePaths)
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
		{name: "status kind", mutate: func(value *ProviderDescriptor) { value.Status.Kind = "poison" }},
		{name: "status auth command", mutate: func(value *ProviderDescriptor) { value.Status.AuthStatusCommand[0] = " " }},
		{name: "status auth marker", mutate: func(value *ProviderDescriptor) { value.Status.AuthMarkerPaths[0] = " " }},
		{name: "status login args", mutate: func(value *ProviderDescriptor) { value.Status.LoginArgs[0] = " " }},
		{name: "status npm package", mutate: func(value *ProviderDescriptor) { value.Status.NPMRegistryPackage = " " }},
		{name: "installer kind", mutate: func(value *ProviderDescriptor) { value.Status.Install.Kind = "poison" }},
		{name: "installer package mismatch", mutate: func(value *ProviderDescriptor) { value.Status.Install.PackageName = "poison" }},
		{name: "model catalog kind", mutate: func(value *ProviderDescriptor) { value.ComposerProfile.ModelCatalog = "poison" }},
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
