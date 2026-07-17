package agentextension

import (
	"context"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

type SetupActionStore interface {
	Read(context.Context, agentextensionbiz.SetupActionScope) (*agentextensionbiz.SetupAction, error)
	Put(context.Context, agentextensionbiz.SetupActionScope, agentextensionbiz.SetupAction) error
}

type SetupDiscoveryDirectory interface {
	Ensure(context.Context) (string, error)
}

func setupActionScope(plan InstallPlan) agentextensionbiz.SetupActionScope {
	return agentextensionbiz.SetupActionScope{
		AgentTargetID:           plan.AgentTargetID,
		ExtensionInstallationID: plan.ExtensionInstallationID,
	}
}
