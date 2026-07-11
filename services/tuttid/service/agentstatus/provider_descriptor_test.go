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
