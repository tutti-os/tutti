package agentextension

import (
	"context"

	agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"
)

type AccountUsageCompanionFailureStore interface {
	Read(context.Context, agentextensionbiz.AccountUsageCompanionFailureScope) (*agentextensionbiz.AccountUsageCompanionFailure, error)
	Put(context.Context, agentextensionbiz.AccountUsageCompanionFailureScope, agentextensionbiz.AccountUsageCompanionFailure) error
	Delete(context.Context, agentextensionbiz.AccountUsageCompanionFailureScope) error
}

func accountUsageCompanionFailureScope(targetID, installationID string) agentextensionbiz.AccountUsageCompanionFailureScope {
	return agentextensionbiz.AccountUsageCompanionFailureScope{
		AgentTargetID: targetID, ExtensionInstallationID: installationID,
	}
}
