package api

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func TestMigratedProviderDescriptorsMatchGeneratedAPIEnums(t *testing.T) {
	if err := providerregistry.ValidateMigrated(); err != nil {
		t.Fatalf("ValidateMigrated() error = %v", err)
	}
	for _, descriptor := range providerregistry.Migrated() {
		providerID := descriptor.Identity.ID
		if !tuttigenerated.WorkspaceAgentProvider(providerID).Valid() {
			t.Errorf("provider %q missing from WorkspaceAgentProvider", providerID)
		}
		if !tuttigenerated.AgentTargetProvider(providerID).Valid() {
			t.Errorf("provider %q missing from AgentTargetProvider", providerID)
		}
	}
}
