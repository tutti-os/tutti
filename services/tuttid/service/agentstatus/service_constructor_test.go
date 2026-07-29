package agentstatus

import (
	"testing"

	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func TestNewServiceInitializesProductionDependencies(t *testing.T) {
	selectionStore := &memoryCodexRuntimeSelectionStore{}
	service := NewService(ServiceDependencies{
		ManagedRuntime:             managedruntime.DefaultResolver{RuntimeRoot: "/runtime"},
		ClaudeCodeRuntimeDir:       "/claude-code",
		CodexRuntimeSelectionStore: selectionStore,
	})

	resolver, ok := service.ManagedRuntime.(managedruntime.DefaultResolver)
	if !ok || resolver.RuntimeRoot != "/runtime" {
		t.Fatalf("ManagedRuntime = %#v, want configured default resolver", service.ManagedRuntime)
	}
	if service.ClaudeCodeRuntimeDir != "/claude-code" {
		t.Fatalf("ClaudeCodeRuntimeDir = %q", service.ClaudeCodeRuntimeDir)
	}
	if service.CodexRuntimeSelectionStore != selectionStore {
		t.Fatalf("CodexRuntimeSelectionStore = %#v, want configured store", service.CodexRuntimeSelectionStore)
	}
	if service.RunOutcomes == nil || service.StatusCache == nil || service.CLIVersionCache == nil ||
		service.AdapterProbeCache == nil || service.BunGlobalBinCache == nil ||
		service.GlobalBinDiscoveryCache == nil || service.DetectionCommands == nil || service.UpdateCache == nil {
		t.Fatalf("NewService() did not initialize all production dependencies: %#v", service)
	}
}
