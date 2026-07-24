package providerregistry

import (
	"fmt"
	"strings"
)

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
