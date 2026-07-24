package agentruntime

import (
	"encoding/json"
	"errors"
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
				rateLimits:          providerDescriptorHasCapability(descriptor, CapabilityRateLimits),
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
		case providerregistry.StandardACPAdapterStrategyOpenCode:
			return newOpenCodeAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
		default:
			return nil
		}
	case providerregistry.RuntimeKindClaudeSDK:
		return NewClaudeCodeSDKAdapter(transport)
	default:
		return nil
	}
}

func providerDescriptorHasCapability(descriptor providerregistry.ProviderDescriptor, capability string) bool {
	for _, candidate := range descriptor.ComposerProfile.Capabilities {
		if candidate == capability {
			return true
		}
	}
	return false
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
			commandResolver:   commandResolver,
			planModeRuntimeID: strings.TrimSpace(standardACP.PlanModeRuntimeID),
			planModeDisabledRuntimeID: strings.TrimSpace(
				standardACP.PlanModeDisabledRuntimeID,
			),
			projectCurrentMode: standardACP.ProjectCurrentMode,
			startupDiagnostics: standardACP.StartupDiagnostics,
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
}

type StandardACPAdapterConfig struct {
	Provider                     string
	Name                         string
	DisplayName                  string
	Command                      []string
	AuthMessage                  string
	ToolAliases                  map[string]string
	ModelConfigOptionID          string
	PermissionConfigOptionID     string
	ReasoningConfigOptionID      string
	RestrictConfigOptions        bool
	PermissionModes              map[string]string
	AutomaticPermissionDecisions map[string]string
	PlanModeRuntimeID            string
	PlanModeDisabledRuntimeID    string
	PlanModeUsesLaunchPermission bool
	LaunchPermission             *StandardACPLaunchPermissionSetting
	SetModelReasoningEffortMeta  bool
	Capabilities                 []string
	AgentTargetID                string
	InstallationID               string
	ExecutableIdentity           *ExecutableIdentity
}

// NewStandardACPAdapter creates the generic, data-driven ACP adapter used by
// verified Agent Extension installations. It intentionally exposes no hooks
// for loading extension code into the daemon.
func NewStandardACPAdapter(config StandardACPAdapterConfig, transport ProcessTransport, host HostMetadata) (Adapter, error) {
	provider := strings.TrimSpace(config.Provider)
	if provider == "" || len(config.Command) == 0 || strings.TrimSpace(config.Command[0]) == "" {
		return nil, fmt.Errorf("standard ACP provider and command are required")
	}
	launchPermission, err := validateStandardACPLaunchPermissionSetting(config.Command, config.LaunchPermission)
	if err != nil {
		return nil, err
	}
	if config.PlanModeUsesLaunchPermission {
		planRuntimeID := strings.TrimSpace(config.PlanModeRuntimeID)
		if launchPermission == nil || !standardACPLaunchSettingValuePattern.MatchString(planRuntimeID) {
			return nil, errors.New("standard ACP launch-permission Plan mode declaration is invalid")
		}
		for _, permissionRuntimeID := range launchPermission.Values {
			if planRuntimeID == permissionRuntimeID {
				return nil, errors.New("standard ACP launch-permission Plan mode must use a distinct runtime value")
			}
		}
	}
	host = normalizeHostMetadata(host)
	permissionModes := cloneStandardACPToolAliases(config.PermissionModes)
	adapter := &standardACPAdapter{
		config: standardACPConfig{
			provider:                     provider,
			adapterName:                  strings.TrimSpace(config.Name),
			command:                      append([]string(nil), config.Command...),
			defaultTitle:                 strings.TrimSpace(config.DisplayName),
			defaultTitleAliases:          []string{strings.TrimSpace(config.DisplayName), provider},
			authRequiredMessage:          strings.TrimSpace(config.AuthMessage),
			toolAliases:                  cloneStandardACPToolAliases(config.ToolAliases),
			modelConfigOptionID:          strings.TrimSpace(config.ModelConfigOptionID),
			permissionConfigOptionID:     strings.TrimSpace(config.PermissionConfigOptionID),
			reasoningConfigOptionID:      strings.TrimSpace(config.ReasoningConfigOptionID),
			restrictConfigOptions:        config.RestrictConfigOptions,
			capabilities:                 append([]string(nil), config.Capabilities...),
			agentTargetID:                strings.TrimSpace(config.AgentTargetID),
			installationID:               strings.TrimSpace(config.InstallationID),
			executableIdentity:           cloneExecutableIdentity(config.ExecutableIdentity),
			permissionModeID:             func(input string) string { return permissionModes[strings.ToLower(strings.TrimSpace(input))] },
			planModeRuntimeID:            strings.TrimSpace(config.PlanModeRuntimeID),
			planModeDisabledRuntimeID:    strings.TrimSpace(config.PlanModeDisabledRuntimeID),
			planModeUsesLaunchPermission: config.PlanModeUsesLaunchPermission,
			failOnSetModeError:           strings.TrimSpace(config.PlanModeRuntimeID) != "" && !config.PlanModeUsesLaunchPermission,
			launchPermission:             launchPermission,
			setModelReasoningEffortMeta:  config.SetModelReasoningEffortMeta,
			initializeParams:             func() map[string]any { return defaultACPInitializeParams(host) },
			env:                          func(session Session) []string { return standardACPEnv(session, host) },
		},
		transport: transport, host: host, sessions: make(map[string]*standardACPSession),
	}
	if decisions := automaticPermissionDecisionFromMap(config.AutomaticPermissionDecisions); decisions != nil {
		adapter.config.automaticPermissionDecision = decisions
	}
	return adapter, nil
}

func automaticPermissionDecisionFromMap(input map[string]string) func(string) string {
	decisions := make(map[string]string, len(input))
	for id, decision := range input {
		normalizedID := strings.ToLower(strings.TrimSpace(id))
		normalizedDecision := strings.TrimSpace(decision)
		if normalizedID != "" && (normalizedDecision == "approved" || normalizedDecision == "denied") {
			decisions[normalizedID] = normalizedDecision
		}
	}
	if len(decisions) == 0 {
		return nil
	}
	return func(permissionModeID string) string {
		return decisions[strings.ToLower(strings.TrimSpace(permissionModeID))]
	}
}

func cloneStandardACPToolAliases(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
	}
	return result
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
