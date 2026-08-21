package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func (api DaemonAPI) agentSideConversationEnabled(ctx context.Context) bool {
	if api.PreferencesService == nil {
		return false
	}
	preferences, err := api.PreferencesService.Get(ctx)
	if err != nil {
		return false
	}
	return preferencesbiz.IsLabFlagEnabled(
		preferences.FeatureFlags,
		preferencesbiz.LabFlagAgentSideConversation,
	)
}

func agentSideConversationDisabledError() tuttigenerated.InvalidRequestErrorJSONResponse {
	return invalidRequestError(apierrors.InvalidRequest(
		"agent_side_conversation_disabled",
		apierrors.WithDeveloperMessage(
			"agent Side conversations require the lab.agentSideConversation feature flag",
		),
	))
}
