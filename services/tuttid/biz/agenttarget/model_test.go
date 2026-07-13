package agenttarget

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestDefaultSystemTargetsUseMigratedProviderDescriptors(t *testing.T) {
	targets := DefaultSystemTargets(123)
	if len(targets) == 0 {
		t.Fatal("DefaultSystemTargets() returned no targets")
	}
	for index := 1; index < len(targets); index++ {
		if targets[index-1].SortOrder > targets[index].SortOrder {
			t.Fatalf("targets are not sorted by descriptor order: %#v", targets)
		}
	}
	for _, descriptor := range providerregistry.Migrated() {
		var target *Target
		for index := range targets {
			if targets[index].ID == descriptor.Target.ID {
				target = &targets[index]
				break
			}
		}
		if target == nil {
			t.Fatalf("migrated target %q missing from %#v", descriptor.Target.ID, targets)
		}
		if target.ID != descriptor.Target.ID || target.Provider != descriptor.Identity.ID {
			t.Fatalf("target identity = %#v", target)
		}
		if target.Name != descriptor.Identity.DisplayName || target.IconKey != descriptor.Identity.IconKey {
			t.Fatalf("target presentation = %#v", target)
		}
		if target.SortOrder != descriptor.Target.SortOrder || target.CreatedAtUnixMS != 123 {
			t.Fatalf("target ordering/timestamp = %#v", target)
		}
	}
}
