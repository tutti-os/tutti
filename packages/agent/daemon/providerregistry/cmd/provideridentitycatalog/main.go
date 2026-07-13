// Command provideridentitycatalog emits the GUI-facing identity and target
// catalog for providers that have completed the provider-registry migration.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

type catalogEntry struct {
	ProviderID  string   `json:"providerId"`
	DisplayName string   `json:"displayName"`
	IconKey     string   `json:"iconKey"`
	LocaleKey   string   `json:"localeKey"`
	Aliases     []string `json:"aliases"`
	Target      target   `json:"target"`
	Desktop     desktop  `json:"desktop"`
}

type target struct {
	ID            string `json:"id"`
	LaunchRefType string `json:"launchRefType"`
	Enabled       bool   `json:"enabled"`
	SortOrder     int    `json:"sortOrder"`
}

type desktop struct {
	Managed                    bool   `json:"managed"`
	ManagedOrder               int    `json:"managedOrder"`
	StatusProbePriority        int    `json:"statusProbePriority"`
	UsageProbeKind             string `json:"usageProbeKind"`
	VisibilityGate             string `json:"visibilityGate"`
	RuntimeProbeFallback       string `json:"runtimeProbeFallback"`
	InstallBootstrap           bool   `json:"installBootstrap"`
	RefreshOnAccountChange     bool   `json:"refreshOnAccountChange"`
	UnavailableDockOrderOffset int    `json:"unavailableDockOrderOffset"`
	DeveloperLogs              bool   `json:"developerLogs"`
	DefaultProviderEligible    bool   `json:"defaultProviderEligible"`
	DefaultProviderPriority    int    `json:"defaultProviderPriority"`
}

func main() {
	if err := providerregistry.ValidateMigrated(); err != nil {
		fatal(err)
	}

	descriptors := providerregistry.Migrated()
	entries := make([]catalogEntry, 0, len(descriptors))
	for _, descriptor := range descriptors {
		entries = append(entries, catalogEntry{
			ProviderID:  descriptor.Identity.ID,
			DisplayName: descriptor.Identity.DisplayName,
			IconKey:     descriptor.Identity.IconKey,
			LocaleKey:   descriptor.Identity.LocaleKey,
			Aliases:     append([]string{}, descriptor.Identity.Aliases...),
			Target: target{
				ID:            descriptor.Target.ID,
				LaunchRefType: descriptor.Target.LaunchRefType,
				Enabled:       descriptor.Target.Enabled,
				SortOrder:     descriptor.Target.SortOrder,
			},
			Desktop: desktop{
				Managed:                    descriptor.Desktop.Managed,
				ManagedOrder:               descriptor.Desktop.ManagedOrder,
				StatusProbePriority:        descriptor.Desktop.StatusProbePriority,
				UsageProbeKind:             string(descriptor.Desktop.UsageProbeKind),
				VisibilityGate:             string(descriptor.Desktop.VisibilityGate),
				RuntimeProbeFallback:       string(descriptor.Desktop.RuntimeProbeFallback),
				InstallBootstrap:           descriptor.Desktop.InstallBootstrap,
				RefreshOnAccountChange:     descriptor.Desktop.RefreshOnAccountChange,
				UnavailableDockOrderOffset: descriptor.Desktop.UnavailableDockOrderOffset,
				DeveloperLogs:              descriptor.Desktop.DeveloperLogs,
				DefaultProviderEligible:    descriptor.Desktop.DefaultProviderEligible,
				DefaultProviderPriority:    descriptor.Desktop.DefaultProviderPriority,
			},
		})
	}

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(entries); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
