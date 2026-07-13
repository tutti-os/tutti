package agent

import (
	"reflect"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestCodexComposerProfileComesFromProviderDescriptor(t *testing.T) {
	profile := composerProfileFor(agentprovider.Codex)
	if !profile.ModelSelection || !profile.UsesModelCatalog || profile.ModelCatalog != "codex-cli" {
		t.Fatalf("model profile = %#v", profile)
	}
	if len(profile.ReasoningEffortValues) != 0 {
		t.Fatalf("model-catalog reasoning values must not have a static fallback: %#v", profile.ReasoningEffortValues)
	}
	if profile.ReasoningEffortOptions != providerregistry.ReasoningEffortOptionsModelCatalog {
		t.Fatalf("reasoning option source = %q", profile.ReasoningEffortOptions)
	}
	if reasoningConfigOptionID(agentprovider.Codex) != "reasoning_effort" {
		t.Fatalf("reasoning config option = %q", reasoningConfigOptionID(agentprovider.Codex))
	}
	if speedConfigOptionID(agentprovider.Codex) != "service_tier" {
		t.Fatalf("speed config option = %q", speedConfigOptionID(agentprovider.Codex))
	}
	if profile.SkillKind != "codex" || profile.SkillInvocation != "promptItem" {
		t.Fatalf("skill profile = %#v", profile)
	}
	if profile.CapabilityCatalogKind != providerregistry.CapabilityCatalogKindCodexAppServer {
		t.Fatalf("capability catalog profile = %#v", profile)
	}
}

func TestClaudeCodeComposerProfileComesFromProviderDescriptor(t *testing.T) {
	profile := composerProfileFor(agentprovider.ClaudeCode)
	if profile.LiveModelDiscoveryKind != providerregistry.LiveModelDiscoveryKindClaudeSDK ||
		!profile.LiveModelProbeSession || profile.SkillKind != "claude-code" ||
		profile.ReasoningEffortOptions != providerregistry.ReasoningEffortOptionsStatic {
		t.Fatalf("claude composer profile = %#v", profile)
	}
	if !profile.SlashCommandPolicy.CommandCatalogAuthoritative ||
		!profile.Behavior.ModelOptionsAuthoritative ||
		!profile.Behavior.PrewarmDraftSession {
		t.Fatalf("claude composer policies = %#v / %#v", profile.SlashCommandPolicy, profile.Behavior)
	}
}

func TestCursorSkillDiscoveryComesFromProviderDescriptor(t *testing.T) {
	profile := composerProfileFor(agentprovider.Cursor)
	if profile.SkillKind != string(providerregistry.SkillKindCursor) || profile.SkillInvocation != string(providerregistry.SkillInvocationTextTrigger) {
		t.Fatalf("cursor skill profile = %#v", profile)
	}
}

func TestUnknownProviderHasNoComposerProtocolFallbacks(t *testing.T) {
	if got := reasoningConfigOptionID("unknown-provider"); got != "" {
		t.Fatalf("reasoning config option = %q, want empty", got)
	}
	if got := speedConfigOptionID("unknown-provider"); got != "" {
		t.Fatalf("speed config option = %q, want empty", got)
	}
	if got := reasoningEffortValuesForProvider("unknown-provider"); len(got) != 0 {
		t.Fatalf("reasoning effort values = %#v, want none", got)
	}
}

func TestCodexModelCatalogSpecComesFromProviderDescriptor(t *testing.T) {
	spec, ok := agentModelCatalogSpecs[agentprovider.Codex]
	if !ok {
		t.Fatal("codex model catalog spec missing")
	}
	if spec.source != "codex-cli" {
		t.Fatalf("source = %q", spec.source)
	}
	if spec.lister == nil || spec.configuredDefaultModel == nil || spec.configuredModelOnly == nil || spec.configuredModelSource != "codex-configured-model" {
		t.Fatalf("catalog spec incomplete: %#v", spec)
	}
}

func TestOpenCodeComposerProfileComesFromProviderDescriptor(t *testing.T) {
	profile := composerProfileFor(agentprovider.OpenCode)
	if !profile.ModelSelection || !profile.UsesModelCatalog || profile.ModelCatalog != "opencode-cli" ||
		!profile.ReasoningEffort || profile.DefaultReasoningEffort != "high" {
		t.Fatalf("opencode profile = %#v", profile)
	}
	if !reflect.DeepEqual(profile.ReasoningEffortValues, []string{"low", "medium", "high", "xhigh"}) {
		t.Fatalf("opencode reasoning values = %#v", profile.ReasoningEffortValues)
	}
	if profile.ReasoningEffortOptions != providerregistry.ReasoningEffortOptionsStatic || profile.SkillConfigDirSuffix != "opencode" {
		t.Fatalf("opencode strategy profile = %#v", profile)
	}
	if reasoningConfigOptionID(agentprovider.OpenCode) != "effort" {
		t.Fatalf("opencode reasoning config option = %q", reasoningConfigOptionID(agentprovider.OpenCode))
	}
	for _, capability := range []string{"imageInput", "modelImageInputRequired", "planMode", "interrupt"} {
		if !composerProfileHasCapability(agentprovider.OpenCode, capability) {
			t.Fatalf("opencode capability %q missing from %#v", capability, profile.Capabilities)
		}
	}
}

func TestOpenCodeSlashCommandPolicyComesFromProviderDescriptor(t *testing.T) {
	policy := composerSlashCommandPolicy(agentprovider.OpenCode)
	if policy == nil {
		t.Fatal("slash command policy missing")
	}
	if !reflect.DeepEqual(policy.FallbackCommands, []string{"compact", "goal", "review"}) {
		t.Fatalf("fallbackCommands = %#v", policy.FallbackCommands)
	}
	want := []providerregistry.SlashCommandEffectDescriptor{
		{Command: "compact", Effect: providerregistry.SlashCommandEffectSubmitImmediate},
		{Command: "review", Effect: providerregistry.SlashCommandEffectShowReviewPicker},
		{Command: "goal", Effect: providerregistry.SlashCommandEffectActivateGoalMode},
		{Command: "plan", Effect: providerregistry.SlashCommandEffectTogglePlanMode},
	}
	if !reflect.DeepEqual(policy.CommandEffects, want) {
		t.Fatalf("commandEffects = %#v, want %#v", policy.CommandEffects, want)
	}
}

func TestOpenCodeModelCatalogListerUsesDescriptorRuntimeCommand(t *testing.T) {
	descriptor, ok := providerregistry.Find(agentprovider.OpenCode)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	descriptor.Runtime.Command = []string{"poison-opencode", "acp"}
	spec, registered, err := agentModelCatalogSpecFromDescriptor(descriptor)
	if err != nil || !registered {
		t.Fatalf("agentModelCatalogSpecFromDescriptor() = (_, %v, %v)", registered, err)
	}
	lister, ok := spec.lister(&CachedAgentModelCatalog{}).(OpenCodeCLIModelLister)
	if !ok {
		t.Fatalf("lister = %T, want OpenCodeCLIModelLister", spec.lister(&CachedAgentModelCatalog{}))
	}
	if lister.Command != "poison-opencode" || !reflect.DeepEqual(lister.Args, []string{"models"}) {
		t.Fatalf("lister command = %q %#v", lister.Command, lister.Args)
	}
}

func TestCodexModelCatalogListerUsesDescriptorRuntimeCommand(t *testing.T) {
	descriptor, ok := providerregistry.Find(agentprovider.Codex)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	descriptor.Runtime.Command = []string{"poison-codex", "poison-app-server"}
	spec, registered, err := agentModelCatalogSpecFromDescriptor(descriptor)
	if err != nil || !registered {
		t.Fatalf("agentModelCatalogSpecFromDescriptor() = (_, %v, %v)", registered, err)
	}
	lister, ok := spec.lister(&CachedAgentModelCatalog{}).(CodexCLIModelLister)
	if !ok {
		t.Fatalf("lister = %T, want CodexCLIModelLister", spec.lister(&CachedAgentModelCatalog{}))
	}
	if lister.Command != "poison-codex" || !reflect.DeepEqual(lister.Args, []string{"poison-app-server"}) {
		t.Fatalf("lister command = %q %#v", lister.Command, lister.Args)
	}
}

func TestAgentModelCatalogSpecRejectsUnknownDescriptorKind(t *testing.T) {
	descriptor, ok := providerregistry.Find(agentprovider.Codex)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	descriptor.ComposerProfile.ModelCatalog = "poison"
	if _, registered, err := agentModelCatalogSpecFromDescriptor(descriptor); err == nil || registered {
		t.Fatalf("agentModelCatalogSpecFromDescriptor() = (_, %v, %v), want unsupported error", registered, err)
	}
}

func TestCodexCapabilityCatalogCommandComesFromRuntimeDescriptor(t *testing.T) {
	descriptor, ok := providerregistry.Find(agentprovider.Codex)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	descriptor.Runtime.Command = []string{"poison-codex", "poison-app-server"}
	profile := composerProfileFromDescriptor(descriptor)
	lister, ok, err := composerCapabilityCatalogLister(profile)
	if err != nil || !ok {
		t.Fatalf("composerCapabilityCatalogLister() = (%#v, %v, %v)", lister, ok, err)
	}
	if lister.Command != "poison-codex" || !reflect.DeepEqual(lister.Args, []string{"poison-app-server"}) {
		t.Fatalf("lister command = %q %#v", lister.Command, lister.Args)
	}
}

func TestCodexSlashCommandPolicyComesFromProviderDescriptor(t *testing.T) {
	policy := composerSlashCommandPolicy(agentprovider.Codex)
	if policy == nil {
		t.Fatal("slash command policy missing")
	}
	if !reflect.DeepEqual(policy.FallbackCommands, []string{"compact", "status", "fast", "goal", "review"}) {
		t.Fatalf("fallbackCommands = %#v", policy.FallbackCommands)
	}
	want := []providerregistry.SlashCommandEffectDescriptor{
		{Command: "init", Effect: providerregistry.SlashCommandEffectSubmitImmediate},
		{Command: "compact", Effect: providerregistry.SlashCommandEffectSubmitImmediate},
		{Command: "review", Effect: providerregistry.SlashCommandEffectShowReviewPicker},
		{Command: "goal", Effect: providerregistry.SlashCommandEffectActivateGoalMode},
		{Command: "plan", Effect: providerregistry.SlashCommandEffectTogglePlanMode},
		{Command: "status", Effect: providerregistry.SlashCommandEffectShowStatus},
		{Command: "fast", Effect: providerregistry.SlashCommandEffectToggleSpeed},
	}
	if !reflect.DeepEqual(policy.CommandEffects, want) {
		t.Fatalf("commandEffects = %#v, want %#v", policy.CommandEffects, want)
	}
}
