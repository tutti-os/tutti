package agentruntime

import (
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func newMigratedProviderAdapters(
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) []Adapter {
	descriptors := providerregistry.Migrated()
	adapters := make([]Adapter, 0, len(descriptors))
	for _, descriptor := range descriptors {
		if err := providerregistry.Validate(descriptor); err != nil {
			panic(fmt.Sprintf("invalid migrated provider descriptor: %v", err))
		}
		adapter := newAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
		if adapter == nil {
			panic(fmt.Sprintf("provider %q has unsupported runtime kind %q", descriptor.Identity.ID, descriptor.Runtime.Kind))
		}
		if provider := strings.TrimSpace(adapter.Provider()); provider != descriptor.Identity.ID {
			panic(fmt.Sprintf("provider descriptor %q constructed adapter for %q", descriptor.Identity.ID, provider))
		}
		adapters = append(adapters, adapter)
	}
	return adapters
}

func newAdapterFromProviderDescriptor(
	descriptor providerregistry.ProviderDescriptor,
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) Adapter {
	switch descriptor.Runtime.Kind {
	case providerregistry.RuntimeKindCodexAppServer:
		return newAppServerAdapter(
			transport,
			host,
			appServerAdapterConfig{
				provider:            descriptor.Identity.ID,
				runtimeName:         descriptor.Runtime.Name,
				displayName:         descriptor.Identity.DisplayName,
				command:             append([]string(nil), descriptor.Runtime.Command...),
				clientInfoName:      descriptor.Runtime.ClientInfoName,
				authRequiredMessage: descriptor.Runtime.AuthRequiredMessage,
			},
			commandResolver,
		)
	case providerregistry.RuntimeKindClaudeSDK:
		return NewClaudeCodeSDKAdapter(transport)
	default:
		return nil
	}
}

func migratedProviderComposerProfile(provider string) (providerregistry.ComposerProfileDescriptor, bool) {
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return providerregistry.ComposerProfileDescriptor{}, false
	}
	return descriptor.ComposerProfile, true
}
