package agentruntime

import "github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"

// Hermes Agent's ACP provider config (`hermes acp`).

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
