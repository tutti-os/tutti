package providerregistry

import (
	"fmt"
	"strings"
)

func validateUpdateDescriptor(providerID string, status StatusDescriptor) error {
	update := status.Update
	switch update.Capability {
	case UpdateCapabilitySupported:
		if update.Source != UpdateSourceNPM {
			return fmt.Errorf("provider %q update source %q is unsupported", providerID, update.Source)
		}
		if update.Strategy != UpdateStrategyManagedNPM {
			return fmt.Errorf("provider %q update strategy %q is unsupported", providerID, update.Strategy)
		}
		if strings.TrimSpace(update.PackageName) == "" {
			return fmt.Errorf("provider %q update package name is required", providerID)
		}
		if strings.TrimSpace(update.BinaryName) == "" {
			return fmt.Errorf("provider %q update binary name is required", providerID)
		}
		if strings.TrimSpace(update.UnsupportedReason) != "" {
			return fmt.Errorf("provider %q supported update cannot declare an unsupported reason", providerID)
		}
		switch status.Install.Kind {
		case InstallerKindCodexCLILatest, InstallerKindManagedNPM:
			if update.PackageName != status.Install.PackageName || update.BinaryName != status.Install.BinaryName {
				return fmt.Errorf("provider %q update package must match its managed npm installer", providerID)
			}
		default:
			return fmt.Errorf("provider %q update requires a managed npm installer source", providerID)
		}
	case UpdateCapabilityUnsupported:
		if strings.TrimSpace(update.UnsupportedReason) == "" {
			return fmt.Errorf("provider %q unsupported update reason is required", providerID)
		}
		if update.Source != "" || update.Strategy != "" || strings.TrimSpace(update.PackageName) != "" ||
			strings.TrimSpace(update.BinaryName) != "" || update.IncludeOptional {
			return fmt.Errorf("provider %q unsupported update cannot declare an execution source", providerID)
		}
	default:
		return fmt.Errorf("provider %q update capability %q is unsupported", providerID, update.Capability)
	}
	return nil
}
