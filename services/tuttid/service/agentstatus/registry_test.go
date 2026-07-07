package agentstatus

import (
	"runtime"
	"testing"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestDefaultRegistryHasAntigravity(t *testing.T) {
	specs, err := DefaultRegistry().Select([]string{agentprovider.Antigravity})
	if err != nil {
		t.Fatal(err)
	}
	if len(specs) != 1 {
		t.Fatalf("got %d specs, want 1", len(specs))
	}
	spec := specs[0]
	if spec.SupportStatus == ProviderSupportStatusUnsupported {
		t.Fatal("antigravity must ship Available, not Unsupported")
	}
	if len(spec.AdapterCommand) != 1 || spec.AdapterCommand[0] != "agy-acp" {
		t.Fatalf("AdapterCommand = %v, want [agy-acp]", spec.AdapterCommand)
	}
	if len(spec.BinaryNames) != 1 || spec.BinaryNames[0] != "agy" {
		t.Fatalf("BinaryNames = %v, want [agy]", spec.BinaryNames)
	}
	if spec.AdapterInstall.Kind != InstallerKindGitHubReleaseBinary {
		t.Fatalf("AdapterInstall.Kind = %q, want github_release_binary", spec.AdapterInstall.Kind)
	}
	rb := spec.AdapterInstall.ReleaseBinary
	if rb == nil || rb.BinaryName != "agy-acp" || rb.Version != "v1.0.0-tutti.1" {
		t.Fatalf("ReleaseBinary = %+v", rb)
	}
	if _, ok := rb.Assets["darwin-arm64"]; !ok {
		t.Fatalf("missing darwin-arm64 asset; have %v", rb.Assets)
	}
	// validateInstallerSpec must accept it for the current platform.
	if err := validateInstallerSpec(spec.AdapterInstall); err != nil {
		t.Fatalf("AdapterInstall invalid: %v", err)
	}
	// Also assert directly that the current-platform asset resolves through
	// releaseAsset, to catch a platform-key format mismatch (e.g. "x64" vs
	// "amd64") that validateInstallerSpec alone might mask.
	if _, ok := spec.AdapterInstall.releaseAsset(runtime.GOOS, runtime.GOARCH); !ok {
		t.Fatalf("releaseAsset(%s, %s) did not resolve; have keys %v", runtime.GOOS, runtime.GOARCH, rb.Assets)
	}
}
