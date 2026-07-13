package agentstatus

import (
	"reflect"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestCodexStatusSpecComesFromProviderDescriptor(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{agentprovider.Codex})
	if err != nil {
		t.Fatalf("Select(codex) error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("len(specs) = %d", len(specs))
	}
	spec := specs[0]
	if !reflect.DeepEqual(spec.AdapterCommand, []string{"codex", "app-server"}) {
		t.Fatalf("AdapterCommand = %#v", spec.AdapterCommand)
	}
	if !reflect.DeepEqual(spec.AuthStatusCommand, []string{"login", "-c", `service_tier="fast"`, "status"}) {
		t.Fatalf("AuthStatusCommand = %#v", spec.AuthStatusCommand)
	}
	if spec.Install.Kind != InstallerKindCodexCLILatest || spec.Install.CodexCLI == nil {
		t.Fatalf("Install = %#v", spec.Install)
	}
	if spec.MinVersion != providerregistry.CodexMinVersion || spec.NPMRegistryPackage != "@openai/codex" {
		t.Fatalf("status registration = %#v", spec)
	}
	if spec.Install.CodexCLI.PackageName != "@openai/codex" || spec.Install.CodexCLI.BinaryName != "codex" || !spec.Install.CodexCLI.IncludeOptional {
		t.Fatalf("codex installer registration = %#v", spec.Install.CodexCLI)
	}
}

func TestClaudeCodeStatusSpecComesFromProviderDescriptor(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{agentprovider.ClaudeCode})
	if err != nil || len(specs) != 1 {
		t.Fatalf("Select(claude-code) = %#v, %v", specs, err)
	}
	spec := specs[0]
	if spec.Kind != providerregistry.StatusKindClaudeCLI ||
		spec.AuthStatusCommandTimeout != 10*time.Minute {
		t.Fatalf("claude status registration = %#v", spec)
	}
	if spec.Install.Kind != InstallerKindOfficialScript ||
		spec.Install.ScriptURL != "https://claude.ai/install.sh" ||
		spec.Install.ScriptShell != "bash" {
		t.Fatalf("claude installer = %#v", spec.Install)
	}
}

func TestProviderStatusAdapterConsumesDescriptorInstallerData(t *testing.T) {
	descriptor, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	descriptor.Status.MinVersion = "9.9.9"
	descriptor.Status.NPMRegistryPackage = "@poison/codex"
	descriptor.Status.Install.PackageName = "@poison/codex"
	descriptor.Status.Install.BinaryName = "poison-codex"
	descriptor.Status.Install.IncludeOptional = false

	spec, err := providerSpecFromDescriptor(descriptor)
	if err != nil {
		t.Fatalf("providerSpecFromDescriptor() error = %v", err)
	}
	if spec.MinVersion != "9.9.9" || spec.NPMRegistryPackage != "@poison/codex" {
		t.Fatalf("status descriptor values = %#v", spec)
	}
	if spec.Install.CodexCLI == nil || spec.Install.CodexCLI.PackageName != "@poison/codex" ||
		spec.Install.CodexCLI.BinaryName != "poison-codex" || spec.Install.CodexCLI.IncludeOptional {
		t.Fatalf("installer descriptor values = %#v", spec.Install.CodexCLI)
	}
}

func TestOpenCodeStatusSpecComesFromProviderDescriptor(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{agentprovider.OpenCode})
	if err != nil {
		t.Fatalf("Select(opencode) error = %v", err)
	}
	if len(specs) != 1 {
		t.Fatalf("len(specs) = %d", len(specs))
	}
	spec := specs[0]
	if !reflect.DeepEqual(spec.AdapterCommand, []string{"opencode", "acp"}) ||
		!reflect.DeepEqual(spec.AuthStatusCommand, []string{"auth", "list"}) {
		t.Fatalf("status commands = %#v %#v", spec.AdapterCommand, spec.AuthStatusCommand)
	}
	if spec.Install.Kind != InstallerKindOfficialScript ||
		spec.Install.ScriptURL != "https://opencode.ai/install" ||
		spec.Install.ScriptShell != "bash" {
		t.Fatalf("Install = %#v", spec.Install)
	}
}

func TestOpenCodeStatusAdapterConsumesDescriptorInstallerData(t *testing.T) {
	descriptor, ok := providerregistry.Find(providerregistry.OpenCodeProviderID)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	descriptor.Runtime.Command = []string{"poison-opencode", "descriptor-acp"}
	descriptor.Status.Install.DisplayCommand = "descriptor install"
	descriptor.Status.Install.ScriptURL = "https://example.invalid/install"
	descriptor.Status.Install.ScriptShell = "zsh"

	spec, err := providerSpecFromDescriptor(descriptor)
	if err != nil {
		t.Fatalf("providerSpecFromDescriptor() error = %v", err)
	}
	if !reflect.DeepEqual(spec.AdapterCommand, descriptor.Runtime.Command) ||
		spec.Install.DisplayCommand != "descriptor install" ||
		spec.Install.ScriptURL != "https://example.invalid/install" ||
		spec.Install.ScriptShell != "zsh" {
		t.Fatalf("status descriptor values = %#v", spec)
	}
}

func TestOpenCodeStatusHelpersDispatchFromDescriptorStrategy(t *testing.T) {
	descriptor, ok := providerregistry.Find(providerregistry.OpenCodeProviderID)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	if got := providerCustomConfigEnvVars("open-code"); !reflect.DeepEqual(got, descriptor.Status.CustomConfigEnvVars) {
		t.Fatalf("custom config env vars = %#v, want %#v", got, descriptor.Status.CustomConfigEnvVars)
	}
	auth, ok := parseAuthStatusCommandOutput("open-code", []byte("Not authenticated. Run opencode auth login."))
	if !ok || auth.Status != AuthRequired {
		t.Fatalf("parseAuthStatusCommandOutput() = %#v, %v", auth, ok)
	}
}

func TestAuthStrategiesProjectFromProviderDescriptor(t *testing.T) {
	for _, provider := range []string{
		providerregistry.CodexProviderID,
		providerregistry.ClaudeCodeProviderID,
		providerregistry.CursorProviderID,
		providerregistry.TuttiAgentProviderID,
	} {
		descriptor, ok := providerregistry.Find(provider)
		if !ok {
			t.Fatalf("provider %q descriptor missing", provider)
		}
		spec, err := providerSpecFromDescriptor(descriptor)
		if err != nil {
			t.Fatalf("providerSpecFromDescriptor(%q) error = %v", provider, err)
		}
		if spec.AuthOutputParserKind != descriptor.Status.AuthOutputParserKind || spec.AuthMarkerParserKind != descriptor.Status.AuthMarkerParserKind || spec.AuthCommandRunnerKind != descriptor.Status.AuthCommandRunnerKind || spec.StaticSpecResolverKind != descriptor.Status.StaticSpecResolverKind {
			t.Fatalf("provider %q auth strategies = %#v, want %#v", provider, spec, descriptor.Status)
		}
	}
}

func TestProviderStatusAdapterRejectsUnknownInstallerKind(t *testing.T) {
	descriptor, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	descriptor.Status.Install.Kind = providerregistry.InstallerKind("poison")
	if _, err := providerSpecFromDescriptor(descriptor); err == nil {
		t.Fatal("providerSpecFromDescriptor() error = nil, want unsupported installer kind")
	}
}
