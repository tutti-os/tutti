package agentruntime

import "github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"

// Hermes Agent's ACP provider config (`hermes acp`). Tutti exposes a single
// unconfigurable "yolo" permission tier for Hermes, but hermes-agent's own
// ACP session modes (default/accept_edits/dont_ask) still gate some actions
// behind session/request_permission even in the most permissive mode ("...
// except sensitive paths", per hermes-agent's mode descriptions). Auto-
// approving every request client-side is what makes the tier autonomous
// end-to-end; that policy is descriptor-driven (AutoApprovePermissionModeInputIDs)
// so the shared generic-strategy factory installs it on both the default
// controller's construction path and these convenience constructors.

func NewHermesAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewHermesAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewHermesAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	descriptor, ok := providerregistry.Find(ProviderHermes)
	if !ok {
		panic("hermes provider descriptor is missing")
	}
	return newStandardACPAdapterFromProviderDescriptor(descriptor, transport, host, nil)
}
