package agentruntime

import "github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"

// Kimi Code's ACP provider config (`kimi acp`).

func NewKimiCodeAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewKimiCodeAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewKimiCodeAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	descriptor, ok := providerregistry.Find(ProviderKimiCode)
	if !ok {
		panic("kimi-code provider descriptor is missing")
	}
	return newStandardACPAdapterFromProviderDescriptor(descriptor, transport, host, nil)
}
