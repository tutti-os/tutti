package agentruntime

import (
	"encoding/json"
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
	case providerregistry.RuntimeKindStandardACP:
		switch descriptor.Runtime.StandardACP.AdapterStrategy {
		case "", providerregistry.StandardACPAdapterStrategyGeneric:
			return newStandardACPAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
		case providerregistry.StandardACPAdapterStrategyCursor:
			return newCursorAdapterFromProviderDescriptor(descriptor, transport, host, cursorACPCommandResolver)
		case providerregistry.StandardACPAdapterStrategyNexight:
			return newNexightAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
		case providerregistry.StandardACPAdapterStrategyOpenClaw:
			return newOpenClawAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
		default:
			return nil
		}
	case providerregistry.RuntimeKindClaudeSDK:
		return NewClaudeCodeSDKAdapter(transport)
	default:
		return nil
	}
}

func newStandardACPAdapterFromProviderDescriptor(
	descriptor providerregistry.ProviderDescriptor,
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) *standardACPAdapter {
	modeIDs := make(map[string]string, len(descriptor.Runtime.StandardACP.PermissionModes))
	for _, mode := range descriptor.Runtime.StandardACP.PermissionModes {
		modeIDs[strings.TrimSpace(mode.InputID)] = strings.TrimSpace(mode.RuntimeID)
	}
	settingsEnvironment := descriptor.Runtime.StandardACP.SettingsEnvironment
	standardACP := descriptor.Runtime.StandardACP
	defaultRuntimeModeID := strings.TrimSpace(descriptor.Runtime.StandardACP.DefaultPermissionModeRuntimeID)
	return &standardACPAdapter{
		config: standardACPConfig{
			provider:            descriptor.Identity.ID,
			adapterName:         descriptor.Runtime.Name,
			command:             append([]string(nil), descriptor.Runtime.Command...),
			defaultTitle:        descriptor.Identity.DisplayName,
			defaultTitleAliases: append([]string{descriptor.Identity.DisplayName, descriptor.Identity.ID}, descriptor.Identity.Aliases...),
			authRequiredMessage: descriptor.Runtime.AuthRequiredMessage,
			permissionModeID: func(mode string) string {
				if runtimeModeID := modeIDs[strings.TrimSpace(mode)]; runtimeModeID != "" {
					return runtimeModeID
				}
				return defaultRuntimeModeID
			},
			initializeParams: func() map[string]any { return defaultACPInitializeParams(host) },
			env: func(session Session) []string {
				env := standardACPEnv(session, host)
				if value := runtimeSettingsEnvironmentValue(settingsEnvironment, session); value != "" {
					env = append(env, settingsEnvironment.Variable+"="+value)
				}
				return env
			},
			commandResolver:    commandResolver,
			planModeRuntimeID:  strings.TrimSpace(standardACP.PlanModeRuntimeID),
			projectCurrentMode: standardACP.ProjectCurrentMode,
			startupDiagnostics: standardACP.StartupDiagnostics,
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
}

func runtimeSettingsEnvironmentValue(
	descriptor providerregistry.RuntimeSettingsEnvironmentDescriptor,
	session Session,
) string {
	settings := session.SettingsValue()
	values := make(map[string]string, len(descriptor.JSONFields))
	for _, field := range descriptor.JSONFields {
		var value string
		if field.Setting == providerregistry.RuntimeSettingFieldModel {
			value = strings.TrimSpace(settings.Model)
		}
		if value != "" {
			values[field.JSONKey] = value
		}
	}
	if len(values) == 0 {
		return ""
	}
	data, err := json.Marshal(values)
	if err != nil {
		return ""
	}
	return string(data)
}

func migratedProviderComposerProfile(provider string) (providerregistry.ComposerProfileDescriptor, bool) {
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return providerregistry.ComposerProfileDescriptor{}, false
	}
	return descriptor.ComposerProfile, true
}
