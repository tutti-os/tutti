package agentextension

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type RuntimeResolver struct {
	Manager   *Manager
	Transport agentruntime.ProcessTransport
	Host      agentruntime.HostMetadata
}

type RuntimeBinding struct {
	Installation                 Installation
	Command                      []string
	Version                      string
	Source                       string
	ToolAliases                  map[string]string
	AuthenticationMethods        map[string]AuthenticationMethodProfile
	ModelConfigOptionID          string
	PermissionConfigOptionID     string
	ReasoningConfigOptionID      string
	PermissionModes              map[string]string
	AutomaticPermissionDecisions map[string]string
	PlanModeRuntimeID            string
	PlanModeDisabledRuntimeID    string
	PlanModeUsesLaunchPermission bool
	LaunchPermission             *agentruntime.StandardACPLaunchPermissionSetting
	SetModelReasoningEffortMeta  bool
	Capabilities                 []string
	ExecutableIdentity           *agentruntime.ExecutableIdentity
	Env                          []string
}

type AccountUsageRuntimeBinding struct {
	NodePath       string
	ScriptPath     string
	Args           []string
	Timeout        time.Duration
	NodeIdentity   *agentruntime.ExecutableIdentity
	ScriptIdentity *agentruntime.ExecutableIdentity
}

func (r RuntimeResolver) ResolveAdapter(ctx context.Context, input agentruntime.AdapterResolveInput) (agentruntime.Adapter, error) {
	if r.Manager == nil || r.Transport == nil {
		return nil, errors.New("agent extension runtime resolver is not configured")
	}
	if kind, _ := input.ProviderTargetRef["kind"].(string); kind != "agent_extension" {
		return nil, fmt.Errorf("dynamic provider %q requires an agent_extension target", input.Provider)
	}
	installationID, _ := input.ProviderTargetRef["extensionInstallationId"].(string)
	installationID = strings.TrimSpace(installationID)
	if installationID == "" {
		return nil, errors.New("agent extension installation id is required")
	}
	binding, err := r.Manager.ResolveRuntimeForCWD(ctx, installationID, input.CWD)
	if err != nil {
		return nil, err
	}
	if binding.Installation.Provider != strings.TrimSpace(input.Provider) {
		return nil, errors.New("agent extension provider does not match installation")
	}
	return newRuntimeAdapter(binding, strings.TrimSpace(input.AgentTargetID), r.Transport, r.Host)
}

func newRuntimeAdapter(binding RuntimeBinding, agentTargetID string, transport agentruntime.ProcessTransport, host agentruntime.HostMetadata) (agentruntime.Adapter, error) {
	return agentruntime.NewStandardACPAdapter(runtimeAdapterConfig(binding, agentTargetID), transport, host)
}

func runtimeAdapterConfig(binding RuntimeBinding, agentTargetID string) agentruntime.StandardACPAdapterConfig {
	return agentruntime.StandardACPAdapterConfig{
		Provider:                     binding.Installation.Provider,
		Name:                         binding.Installation.AgentKey + "-acp",
		DisplayName:                  binding.Installation.DisplayName,
		Command:                      binding.Command,
		AuthMessage:                  binding.Installation.AuthMessage,
		ToolAliases:                  binding.ToolAliases,
		ModelConfigOptionID:          binding.ModelConfigOptionID,
		PermissionConfigOptionID:     binding.PermissionConfigOptionID,
		ReasoningConfigOptionID:      binding.ReasoningConfigOptionID,
		RestrictConfigOptions:        true,
		PermissionModes:              binding.PermissionModes,
		AutomaticPermissionDecisions: binding.AutomaticPermissionDecisions,
		PlanModeRuntimeID:            binding.PlanModeRuntimeID,
		PlanModeDisabledRuntimeID:    binding.PlanModeDisabledRuntimeID,
		PlanModeUsesLaunchPermission: binding.PlanModeUsesLaunchPermission,
		LaunchPermission:             binding.LaunchPermission,
		SetModelReasoningEffortMeta:  binding.SetModelReasoningEffortMeta,
		Capabilities:                 binding.Capabilities,
		AgentTargetID:                strings.TrimSpace(agentTargetID),
		InstallationID:               binding.Installation.ID,
		ExecutableIdentity:           binding.ExecutableIdentity,
		Env:                          append([]string(nil), binding.Env...),
	}
}

func resolveRuntimeLaunchEnv(declarations map[string]string) []string {
	if len(declarations) == 0 {
		return nil
	}
	keys := make([]string, 0, len(declarations))
	for key := range declarations {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		matches := runtimeEnvironmentReferencePattern.FindStringSubmatch(strings.TrimSpace(declarations[key]))
		if len(matches) != 2 {
			continue
		}
		value := strings.TrimSpace(os.Getenv(matches[1]))
		if value != "" {
			result = append(result, key+"="+value)
		}
	}
	return result
}
