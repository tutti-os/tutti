package agentextension

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

type RuntimeResolver struct {
	Manager   *Manager
	Transport agentruntime.ProcessTransport
	Host      agentruntime.HostMetadata
}

type RuntimeBinding struct {
	Installation             Installation
	Command                  []string
	Version                  string
	Source                   string
	ToolAliases              map[string]string
	ModelConfigOptionID      string
	PermissionConfigOptionID string
	ReasoningConfigOptionID  string
	PermissionModes          map[string]string
	PlanModeRuntimeID        string
	Capabilities             []string
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
		Provider:                 binding.Installation.Provider,
		Name:                     binding.Installation.AgentKey + "-acp",
		DisplayName:              binding.Installation.DisplayName,
		Command:                  binding.Command,
		AuthMessage:              binding.Installation.AuthMessage,
		ToolAliases:              binding.ToolAliases,
		ModelConfigOptionID:      binding.ModelConfigOptionID,
		PermissionConfigOptionID: binding.PermissionConfigOptionID,
		ReasoningConfigOptionID:  binding.ReasoningConfigOptionID,
		RestrictConfigOptions:    true,
		PermissionModes:          binding.PermissionModes,
		PlanModeRuntimeID:        binding.PlanModeRuntimeID,
		Capabilities:             binding.Capabilities,
		AgentTargetID:            strings.TrimSpace(agentTargetID),
		InstallationID:           binding.Installation.ID,
	}
}
